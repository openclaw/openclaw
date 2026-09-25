import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { afterEach, expect, test, vi } from "vitest";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findGitCheckoutRoot } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { isSessionLifecycleMutationActive } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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

test("sessions.create accepts a node-host cwd without provisioning a Gateway worktree", async () => {
  // A running suite server can read config before this test installs its per-case session store.
  getRuntimeConfig();
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { execHost?: string; execNode?: string; execCwd?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", execNode: "macbook", cwd: "/Users/peter/Projects/openclaw" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    execHost: "node",
    execNode: "macbook",
    execCwd: "/Users/peter/Projects/openclaw",
  });
  expect(created.payload?.entry.spawnedCwd).toBeUndefined();
  const sessionKey = requireNonEmptyString(created.payload?.key, "node session key");
  const stored = loadSessionEntry({ agentId: "main", sessionKey, storePath });
  expect(stored).toMatchObject({ execHost: "node", execNode: "macbook" });
  expect(stored).not.toHaveProperty("sessionDiffBaselineCapture");
});

test("sessions.create accepts a Windows node-host cwd from a non-Windows Gateway", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq<{
    entry: { execNode?: string; execCwd?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", execNode: "windows-box", cwd: "C:\\Users\\peter\\Projects" },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(created.payload?.entry).toMatchObject({
    execNode: "windows-box",
    execCwd: "C:\\Users\\peter\\Projects",
  });
  expect(created.payload?.entry.spawnedCwd).toBeUndefined();
});

test("sessions.create rejects a Gateway worktree targeting a node", async () => {
  await createSessionStoreDir();
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", execNode: "macbook", worktree: true },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created).toMatchObject({
    ok: false,
    error: { message: "sessions.create worktree cannot target execNode" },
  });
});

test("sessions.create persists a canonical Gateway cwd without a managed worktree", async () => {
  const root = tempDirs.make("openclaw-session-admin-cwd-");
  const cwd = path.join(root, "real");
  const alias = path.join(root, "alias");
  await fs.mkdir(cwd);
  await fs.symlink(cwd, alias, "dir");
  const created = await directSessionReq(
    "sessions.create",
    { cwd: alias },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );

  expect(created.ok).toBe(true);
  expect(
    (
      created.payload as {
        entry?: { sessionRoot?: string; spawnedCwd?: string };
      }
    )?.entry,
  ).toMatchObject({ sessionRoot: cwd, spawnedCwd: cwd });
});

test("sessions.create rejects a regular-file Gateway cwd before creating session state", async () => {
  const root = tempDirs.make("openclaw-session-file-cwd-");
  const cwd = path.join(root, "workspace.txt");
  const key = "agent:main:dashboard:file-cwd";
  await fs.writeFile(cwd, "not a directory\n");
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(root, "device.json"),
  });
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
    const { ws } = await openClient({
      scopes: [scope],
      deviceIdentityPath: path.join(root, "cwd-device.json"),
    });
    try {
      const key = "agent:main:dashboard:canonical-cwd";
      const created = await rpcReq<{
        entry?: { sessionRoot?: string; spawnedCwd?: string };
      }>(ws, "sessions.create", { key, cwd });

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

test("sessions.create records the selected agent workspace when cwd is omitted", async () => {
  const workspace = tempDirs.make("openclaw-session-default-root-");
  const expectedRoot = await fs.realpath(workspace);
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  try {
    const created = await directSessionReq<{
      entry: { permissionMode?: string; sessionRoot?: string; spawnedCwd?: string };
      key?: string;
      sessionId?: string;
    }>("sessions.create", { agentId: "main", permissionMode: "guarded" });

    expect(created.ok).toBe(true);
    expect(created.payload?.entry).toMatchObject({
      permissionMode: "guarded",
      sessionRoot: expectedRoot,
    });
    expect(created.payload?.entry.spawnedCwd).toBeUndefined();
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: requireNonEmptyString(created.payload?.sessionId, "guarded session id"),
        sessionKey: requireNonEmptyString(created.payload?.key, "guarded session key"),
        storePath,
      }),
    ).resolves.toEqual([expect.objectContaining({ cwd: expectedRoot, type: "session" })]);
  } finally {
    testState.agentConfig = undefined;
  }
});

test("sessions.create requires admin for full permission mode", async () => {
  const workspace = tempDirs.make("openclaw-session-full-mode-");
  testState.agentConfig = { workspace };
  const writer = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(workspace, "writer.json"),
  });
  const admin = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(workspace, "admin.json"),
  });
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
  const { ws } = await openClient({
    scopes: ["operator.write"],
    deviceIdentityPath: path.join(workspace, "outside-cwd-device.json"),
  });
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
  const client = { client: { connect: { scopes: ["operator.admin"] } } as never };
  const direct = await directSessionReq("sessions.create", { cwd }, client);
  expect(direct.ok).toBe(true);
  expect((direct.payload as { entry?: { spawnedCwd?: string } })?.entry?.spawnedCwd).toBe(cwd);

  const isolated = await directSessionReq("sessions.create", { cwd, worktree: true }, client);
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

test.each(["direct path", "symlink escape"])(
  "sessions.create rejects sandboxed admin cwd via %s without creating a session",
  async (kind) => {
    const root = tempDirs.make("openclaw-session-sandbox-workspace-");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    const link = path.join(workspace, "escape");
    await fs.symlink(outside, link, directoryLinkType);
    testState.agentConfig = { workspace, sandbox: { mode: "all" } };
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openClient({
      scopes: ["operator.admin"],
      deviceIdentityPath: path.join(root, "admin-device.json"),
    });
    try {
      const key = "agent:main:dashboard:denied-cwd";
      const created = await rpcReq(ws, "sessions.create", {
        key,
        cwd: kind === "direct path" ? outside : link,
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
  },
);

test.each([
  { name: "a dirty checkout", outcome: "dirty" },
  { name: "a concurrently finalized checkout", outcome: "finalized" },
  { name: "successful cleanup", outcome: "removed" },
  { name: "a cleanup exception", outcome: "failed" },
] as const)(
  "sessions.create reset-in-place reports cleanup truth for $name",
  async ({ outcome }) => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-reset-retained-worktree-",
    });
    const root = openClawState.root;
    const workspace = await copyGitWorkspace(gitWorkspaceTemplate, root);
    const origin = path.join(root, "origin.git");
    await execFileAsync("git", ["init", "--bare", origin]);
    await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", origin]);
    await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = { workspace };
    testState.sessionConfig = { dmScope: "main" };
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-retained-parent") } });
    const warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const originalRemoveIfLossless = managedWorktrees.removeIfLossless.bind(managedWorktrees);
    let restoreRemoveIfLossless = () => {};
    let worktreeId: string | undefined;
    try {
      const created = await directSessionReq<{
        worktree: { id: string; path: string; branch: string };
      }>(
        "sessions.create",
        { agentId: "main", parentSessionKey: "main", emitCommandHooks: true, worktree: true },
        { client: { connect: { scopes: ["operator.admin"] } } as never },
      );
      expect(created.ok).toBe(true);
      const worktree = created.payload!.worktree;
      worktreeId = worktree.id;
      const dirtyFile = path.join(worktree.path, "retained-work.txt");
      if (outcome === "dirty") {
        await fs.writeFile(dirtyFile, "preserve my work\n");
      } else if (outcome === "finalized" || outcome === "failed") {
        const removeSpy = vi
          .spyOn(managedWorktrees, "removeIfLossless")
          .mockImplementation(async (id) => {
            if (outcome === "failed") {
              throw new Error("simulated cleanup failure");
            }
            await originalRemoveIfLossless(id);
            return false;
          });
        restoreRemoveIfLossless = () => removeSpy.mockRestore();
      }

      const reset = await directSessionReq<{
        entry: { spawnedCwd?: string; sessionRoot?: string; worktree?: unknown };
      }>(
        "sessions.create",
        { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
        { client: { connect: { scopes: ["operator.write"] } } as never },
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
      await openClawState.cleanup();
    }
  },
);

test("sessions.create reset-in-place detaches the prior worktree permission boundary", async () => {
  const openClawState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-reset-session-worktree-",
  });
  const root = openClawState.root;
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, root);
  // A remote makes the base commit reachable from `--remotes`, so leaving the worktree via a
  // plain New Chat is lossless and the reset can remove it (the real leave-worktree flow).
  const origin = path.join(root, "origin.git");
  await execFileAsync("git", ["init", "--bare", origin]);
  await execFileAsync("git", ["-C", workspace, "remote", "add", "origin", origin]);
  await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "main"]);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace, model: { primary: "openai/current-model" } };
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-reset-parent") } });
  let worktreeId: string | undefined;
  let releaseWorktreeRemoval = () => {};
  let restoreRemoveIfLossless = () => {};
  try {
    const created = await directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string; sessionRoot?: string; permissionMode?: string };
      resolved: { modelProvider?: string; model?: string };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        worktree: true,
        permissionMode: "workspace",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

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
    const originalRemoveIfLossless = managedWorktrees.removeIfLossless.bind(managedWorktrees);
    const removalGate = new Promise<void>((resolve) => {
      releaseWorktreeRemoval = resolve;
    });
    const { promise: removalStarted, resolve: markRemovalStarted } = createDeferredCore();
    const removeIfLosslessSpy = vi
      .spyOn(managedWorktrees, "removeIfLossless")
      .mockImplementation(async (id) => {
        if (id === worktree?.id) {
          expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
            targetSessionKey: "agent:main:main",
            reason: "session-reset",
          });
          markRemovalStarted();
          expect(isSessionLifecycleMutationActive(storePath, ["agent:main:main"])).toBe(true);
          await removalGate;
        }
        return await originalRemoveIfLossless(id);
      });
    restoreRemoveIfLossless = () => removeIfLosslessSpy.mockRestore();
    const resetPromise = directSessionReq<{
      key: string;
      entry: { spawnedCwd?: string; sessionRoot?: string; permissionMode?: string };
      resolved: { modelProvider?: string; model?: string };
    }>(
      "sessions.create",
      { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );
    await removalStarted;
    let successorSettled = false;
    const successorPromise = directSessionReq<{
      entry: { spawnedCwd?: string; worktree?: { id: string; branch: string; repoRoot: string } };
      worktree: { id: string; path: string; branch: string };
    }>(
      "sessions.create",
      {
        key: "agent:main:main",
        agentId: "main",
        worktree: true,
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    ).then((result) => {
      successorSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(successorSettled).toBe(false);
    releaseWorktreeRemoval();
    const [reset, successor] = await Promise.all([resetPromise, successorPromise]);
    restoreRemoveIfLossless();
    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.spawnedCwd).toBeUndefined();
    expect(reset.payload?.entry.sessionRoot).toBeUndefined();
    expect(reset.payload?.entry.permissionMode).toBeUndefined();
    expect(reset.payload?.resolved).toEqual({
      modelProvider: "openai",
      model: "current-model",
    });
    expect(getRegistryWorktree(process.env, worktree!.id)?.removedAt).toEqual(expect.any(Number));
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
    await openClawState.cleanup();
  }
});

test("sessions.create rejects worktrees for agent workspaces without a commit", async () => {
  const workspace = await makeNonGitTempDir("openclaw-session-unborn-workspace-");
  await execFileAsync("git", ["init", workspace]);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const created = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );

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
