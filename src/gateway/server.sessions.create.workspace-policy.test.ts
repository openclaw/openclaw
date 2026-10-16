import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { afterEach, expect, test, vi } from "vitest";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findGitCheckoutRoot } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { managedWorktrees, ManagedWorktreeService } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { isSessionLifecycleMutationActive } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { sessionLog } from "./server-methods/sessions-shared.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  directSessionReq,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness(async (makeTempDir) => {
  gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
});
const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
type CreatedSession = {
  key: string;
  entry: SessionEntry;
  resolved: { modelProvider?: string; model?: string };
  worktree: { id: string; path: string; branch: string };
};
function createSession(params: Record<string, unknown>, scope = "operator.admin") {
  return directSessionReq<CreatedSession>("sessions.create", params, {
    client: { connect: { scopes: [scope] } } as never,
  });
}
function openWorkspaceClient(root: string, scope = "operator.admin", name = "device") {
  return openClient({ scopes: [scope], deviceIdentityPath: path.join(root, `${name}.json`) });
}

async function setupResetWorktree(prefix: string, model?: { primary: string }) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix });
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
  testState.agentConfig = { workspace, ...(model ? { model } : {}) };
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-reset-parent") } });
  return {
    workspace,
    storePath,
    async cleanup(worktreeId: string | undefined) {
      if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
        await managedWorktrees.remove({
          id: worktreeId,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
      await disposeSessionReadContexts();
      testState.agentConfig = undefined;
      testState.sessionConfig = undefined;
      await state.cleanup();
    },
  };
}

async function makeNonGitTempDir(prefix: string): Promise<string> {
  let root = await fs.realpath(os.tmpdir());
  for (;;) {
    const checkoutRoot = findGitCheckoutRoot(root);
    if (!checkoutRoot) {
      return tempDirs.make(prefix, root);
    }
    const parent = path.dirname(checkoutRoot);
    if (parent === checkoutRoot) {
      throw new Error("could not find a temp root outside a git checkout");
    }
    root = parent;
  }
}

test("sessions.create accepts a Windows node-host cwd without provisioning a Gateway worktree", async () => {
  // A running suite server can read config before this test installs its per-case session store.
  getRuntimeConfig();
  const { storePath } = await createSessionStoreDir();
  const created = await createSession({
    agentId: "main",
    execNode: "windows-box",
    cwd: "C:\\Users\\peter\\Projects",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    execHost: "node",
    execNode: "windows-box",
    execCwd: "C:\\Users\\peter\\Projects",
  });
  expect(created.payload?.entry.spawnedCwd).toBeUndefined();
  const sessionKey = requireNonEmptyString(created.payload?.key, "node session key");
  const stored = loadSessionEntry({ agentId: "main", sessionKey, storePath });
  expect(stored).toMatchObject({ execHost: "node", execNode: "windows-box" });
  expect(stored).not.toHaveProperty("sessionDiffBaselineCapture");
});

test("sessions.create rejects a Gateway worktree targeting a node", async () => {
  await createSessionStoreDir();
  const created = await createSession({ agentId: "main", execNode: "macbook", worktree: true });

  expect(created).toMatchObject({
    ok: false,
    error: { message: "sessions.create worktree cannot target execNode" },
  });
});

test("sessions.create rejects a regular-file Gateway cwd before creating session state", async () => {
  const root = tempDirs.make("openclaw-session-file-cwd-");
  const cwd = path.join(root, "workspace.txt");
  const key = "agent:main:dashboard:file-cwd";
  await fs.writeFile(cwd, "not a directory\n");
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openWorkspaceClient(root);
  try {
    const created = await rpcReq(ws, "sessions.create", { agentId: "main", key, cwd });

    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create cwd is not a directory",
      },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  } finally {
    ws.close();
  }
});

test.each(["operator.admin", "operator.write"])(
  "sessions.create canonicalizes sandbox workspace aliases for %s",
  async (scope) => {
    const root = tempDirs.make("openclaw-session-cwd-workspace-");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "alias");
    const cwd = path.join(workspace, "packages", "app");
    await fs.mkdir(cwd, { recursive: true });
    await fs.symlink(workspace, alias, directoryLinkType);
    testState.agentConfig = { workspace: alias, sandbox: { mode: "all" } };
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openWorkspaceClient(root, scope, "cwd-device");
    try {
      const key = "agent:main:dashboard:canonical-cwd";
      const created = await rpcReq<{
        entry?: { sessionRoot?: string; spawnedCwd?: string };
      }>(ws, "sessions.create", { key, cwd: path.join(alias, "packages", "app") });

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.entry).toMatchObject({ sessionRoot: cwd, spawnedCwd: cwd });
      expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
        sessionRoot: cwd,
        spawnedCwd: cwd,
      });
    } finally {
      ws.close();
      testState.agentConfig = undefined;
    }
  },
);

test("sessions.create requires admin for full permission mode", async () => {
  const workspace = tempDirs.make("openclaw-session-full-mode-");
  testState.agentConfig = { workspace };
  const writer = await openWorkspaceClient(workspace, "operator.write", "writer");
  const admin = await openWorkspaceClient(workspace, "operator.admin", "admin");
  try {
    await expect(
      rpcReq(writer.ws, "sessions.create", { agentId: "main", permissionMode: "full" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    await expect(
      rpcReq(admin.ws, "sessions.create", { agentId: "main", permissionMode: "full" }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { entry: { permissionMode: "full", sessionRoot: workspace } },
    });
  } finally {
    writer.ws.close();
    admin.ws.close();
    testState.agentConfig = undefined;
  }
});

test("sessions.create rejects a write-scoped cwd outside configured workspaces", async () => {
  const workspace = tempDirs.make("openclaw-session-cwd-workspace-");
  const outside = tempDirs.make("openclaw-session-cwd-outside-");
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const { ws } = await openWorkspaceClient(workspace, "operator.write", "outside-cwd-device");
  try {
    const created = await rpcReq(ws, "sessions.create", { cwd: outside });

    expect(created).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
  } finally {
    ws.close();
    testState.agentConfig = undefined;
  }
});

test("sessions.create uses a non-git Gateway cwd directly but not as a worktree source", async () => {
  const cwd = await makeNonGitTempDir("openclaw-session-direct-cwd-");
  const direct = await createSession({ cwd });
  expect(direct.ok).toBe(true);
  expect(direct.payload?.entry?.spawnedCwd).toBe(cwd);

  const isolated = await createSession({ cwd, worktree: true });
  expect(isolated.ok).toBe(false);
  expect(isolated.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "agent workspace is not a git checkout",
  });
});

test("sessions.create keeps its cwd contract absolute-only", async () => {
  const created = await directSessionReq("sessions.create", { cwd: "~/repo" });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "sessions.create cwd must be absolute",
  });
});

test("sessions.create rejects sandboxed admin cwd via a symlink escape without creating a session", async () => {
  const root = tempDirs.make("openclaw-session-sandbox-workspace-");
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const link = path.join(workspace, "escape");
  await fs.symlink(outside, link, directoryLinkType);
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openWorkspaceClient(root, "operator.admin", "admin-device");
  try {
    const key = "agent:main:dashboard:denied-cwd";
    const created = await rpcReq(ws, "sessions.create", {
      key,
      cwd: link,
    });
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create cwd is outside the sandboxed agent workspace",
      },
    });
    expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
  } finally {
    ws.close();
    testState.agentConfig = undefined;
  }
});

test.each([
  { name: "a dirty checkout", outcome: "dirty" },
  { name: "a concurrently finalized checkout", outcome: "finalized" },
  { name: "a cleanup exception", outcome: "failed" },
] as const)(
  "sessions.create reset-in-place reports cleanup truth for $name",
  async ({ outcome }) => {
    const { storePath, cleanup } = await setupResetWorktree("openclaw-reset-retained-worktree-");
    const warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const originalRemoveIfLossless = captureMethodCall("removeIfLossless")(
      ManagedWorktreeService.prototype,
    );
    let restoreRemoveIfLossless = () => {};
    let worktreeId: string | undefined;
    try {
      const created = await createSession({
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        worktree: true,
      });
      expect(created.ok).toBe(true);
      const worktree = created.payload!.worktree;
      worktreeId = worktree.id;
      const dirtyFile = path.join(worktree.path, "retained-work.txt");
      if (outcome === "dirty") {
        await fs.writeFile(dirtyFile, "preserve my work\n");
      } else {
        const removeSpy = vi
          .spyOn(ManagedWorktreeService.prototype, "removeIfLossless")
          .mockImplementation(async function (this: ManagedWorktreeService, id) {
            if (outcome === "failed") {
              throw new Error("simulated cleanup failure");
            }
            await originalRemoveIfLossless(this, id);
            return false;
          });
        restoreRemoveIfLossless = () => removeSpy.mockRestore();
      }

      const reset = await createSession(
        { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
        "operator.write",
      );

      expect(reset.ok).toBe(true);
      expect(reset.payload).not.toHaveProperty("worktreePreserved");
      expect(reset.payload?.entry.spawnedCwd).toBeUndefined();
      expect(reset.payload?.entry.sessionRoot).toBeUndefined();
      expect(reset.payload?.entry.worktree).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.worktree,
      ).toBeUndefined();
      if (outcome === "dirty") {
        expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
          runEndCleanup: { outcome: "retained-dirty" },
        });
        await expect(fs.readFile(dirtyFile, "utf8")).resolves.toBe("preserve my work\n");
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(worktree.branch));
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(truncateUtf16Safe(sanitizeForLog(worktree.path), 256)),
        );
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("retained-dirty"));
      } else if (outcome === "failed") {
        expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
        await fs.access(worktree.path);
        expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
          "failed to finalize session worktree lifecycle: simulated cleanup failure",
        );
      } else {
        expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(
          expect.any(Number),
        );
        await expect(fs.access(worktree.path)).rejects.toThrow();
        expect(warnSpy).not.toHaveBeenCalled();
      }
    } finally {
      restoreRemoveIfLossless();
      warnSpy.mockRestore();
      await cleanup(worktreeId);
    }
  },
);

test("sessions.create reset-in-place detaches the prior worktree permission boundary", async () => {
  // A remote makes the base commit reachable from `--remotes`, so leaving the worktree via a
  // plain New Chat is lossless and the reset can remove it (the real leave-worktree flow).
  const { workspace, storePath, cleanup } = await setupResetWorktree(
    "openclaw-reset-session-worktree-",
    { primary: "openai/current-model" },
  );
  const warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
  let worktreeId: string | undefined;
  let releaseWorktreeRemoval = () => {};
  let restoreRemoveIfLossless = () => {};
  try {
    const created = await createSession({
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
      worktree: true,
      permissionMode: "workspace",
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toBe("agent:main:main");
    expect(created.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    const worktree = created.payload?.worktree;
    worktreeId = worktree?.id;
    expect(created.payload?.entry.spawnedCwd).toBe(worktree?.path);
    expect(created.payload?.entry.sessionRoot).toBe(worktree?.path);
    expect(created.payload?.entry.permissionMode).toBe("workspace");
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.spawnedCwd).toBe(
      worktree?.path,
    );

    // Pause the exact old-binding removal before destructive work. A same-key
    // worktree reset must remain fenced until that prior generation is gone.
    const originalRemoveIfLossless = captureMethodCall("removeIfLossless")(
      ManagedWorktreeService.prototype,
    );
    const removalGate = new Promise<void>((resolve) => {
      releaseWorktreeRemoval = resolve;
    });
    const { promise: removalStarted, resolve: markRemovalStarted } = createDeferredCore();
    const removeIfLosslessSpy = vi
      .spyOn(ManagedWorktreeService.prototype, "removeIfLossless")
      .mockImplementation(async function (this: ManagedWorktreeService, id) {
        if (id === worktree?.id) {
          expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
            targetSessionKey: "agent:main:main",
            reason: "session-reset",
          });
          markRemovalStarted();
          expect(isSessionLifecycleMutationActive(storePath, ["agent:main:main"])).toBe(true);
          await removalGate;
        }
        return await originalRemoveIfLossless(this, id);
      });
    restoreRemoveIfLossless = () => removeIfLosslessSpy.mockRestore();
    const resetPromise = createSession(
      { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
      "operator.write",
    );
    await removalStarted;
    let successorSettled = false;
    const successorPromise = createSession({
      key: "agent:main:main",
      agentId: "main",
      worktree: true,
    }).then((result) => {
      successorSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    releaseWorktreeRemoval();
    const [reset, successor] = await Promise.all([resetPromise, successorPromise]);
    restoreRemoveIfLossless();
    expect(reset.ok).toBe(true);
    expect(reset.payload).not.toHaveProperty("worktreePreserved");
    expect(reset.payload?.entry.worktree).toBeUndefined();
    expect(reset.payload?.entry.spawnedCwd).toBeUndefined();
    expect(reset.payload?.entry.sessionRoot).toBeUndefined();
    expect(reset.payload?.entry.permissionMode).toBeUndefined();
    expect(reset.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    expect(getRegistryWorktree(process.env, worktree!.id)?.removedAt).toEqual(expect.any(Number));
    await expect(fs.access(worktree!.path)).rejects.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(successor.ok).toBe(true);
    const successorWorktree = successor.payload!.worktree;
    expect(successorWorktree.id).not.toBe(worktree?.id);
    worktreeId = successorWorktree.id;
    await fs.access(successorWorktree.path);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      spawnedCwd: successorWorktree.path,
      worktree: {
        id: successorWorktree.id,
        branch: successorWorktree.branch,
        repoRoot: workspace,
      },
    });
    expect(getRegistryWorktree(process.env, successorWorktree.id)?.removedAt).toBeUndefined();
  } finally {
    releaseWorktreeRemoval();
    restoreRemoveIfLossless();
    warnSpy.mockRestore();
    await cleanup(worktreeId);
  }
});

test("sessions.create rejects worktrees for agent workspaces without a commit", async () => {
  const workspace = await makeNonGitTempDir("openclaw-session-unborn-workspace-");
  await execFileAsync("git", ["init", workspace]);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const created = await createSession({ agentId: "main", worktree: true });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("git checkout has no commits"),
    });
    expect(created.error?.message).toContain("Create an initial commit, then retry.");
  } finally {
    testState.agentConfig = undefined;
  }
});
