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
function mainSession(params: Record<string, unknown> = {}, scope = "operator.admin") {
  return createSession(
    { agentId: "main", parentSessionKey: "main", emitCommandHooks: true, ...params },
    scope,
  );
}

function expectDetached(result: Awaited<ReturnType<typeof createSession>>) {
  expect(result.ok).toBe(true);
  expect(result.payload).not.toHaveProperty("worktreePreserved");
  for (const field of ["spawnedCwd", "sessionRoot", "worktree"] as const) {
    expect(result.payload?.entry[field], field).toBeUndefined();
  }
}
function expectInvalid(result: Awaited<ReturnType<typeof directSessionReq>>, message: unknown) {
  expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message } });
}
async function openWorkspaceClient(root: string, scope = "operator.admin", name = "device") {
  const client = await openClient({
    scopes: [scope],
    deviceIdentityPath: path.join(root, `${name}.json`),
  });
  return {
    ...client,
    [Symbol.dispose]() {
      client.ws.close();
      testState.agentConfig = undefined;
    },
  };
}

async function setupResetWorktree(prefix: string, model?: { primary: string }) {
  const state = await createOpenClawTestState({ layout: "state-only", prefix });
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
  testState.agentConfig = { workspace, ...(model ? { model } : {}) };
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-reset-parent") } });
  let worktreeId: string | undefined;
  return {
    workspace,
    storePath,
    track(id: string | undefined) {
      worktreeId = id;
    },
    async [Symbol.asyncDispose]() {
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

test.each([
  ["file", "INVALID_REQUEST", "sessions.create cwd is not a directory"],
  ["outside", "FORBIDDEN", "missing scope: operator.admin"],
  ["escape", "INVALID_REQUEST", "sessions.create cwd is outside the sandboxed agent workspace"],
] as const)(
  "sessions.create rejects %s cwd without creating state",
  async (kind, code, message) => {
    const root = tempDirs.make("openclaw-session-cwd-");
    const workspace = path.join(root, "workspace");
    let cwd = path.join(root, kind === "file" ? "workspace.txt" : "outside");
    await fs.mkdir(workspace);
    if (kind === "file") {
      await fs.writeFile(cwd, "not a directory\n");
    } else {
      await fs.mkdir(cwd);
      testState.agentConfig = {
        workspace,
        ...(kind === "escape" ? { sandbox: { mode: "all" as const } } : {}),
      };
      if (kind === "escape") {
        const link = path.join(workspace, "escape");
        await fs.symlink(cwd, link, directoryLinkType);
        cwd = link;
      }
    }
    const { storePath } = await createSessionStoreDir();
    using client = await openWorkspaceClient(
      root,
      kind === "outside" ? "operator.write" : "operator.admin",
    );
    const { ws } = client;
    const key = `agent:main:dashboard:${kind}-cwd`;
    const created = await rpcReq(ws, "sessions.create", {
      cwd,
      ...(kind === "outside" ? {} : { agentId: "main", key }),
    });
    expect(created).toMatchObject({ ok: false, error: { code, message } });
    if (kind !== "outside") {
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
    }
  },
);

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
    using client = await openWorkspaceClient(root, scope, "cwd-device");
    const { ws } = client;
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
  },
);

test("sessions.create requires admin for full permission mode", async () => {
  const workspace = tempDirs.make("openclaw-session-full-mode-");
  testState.agentConfig = { workspace };
  using writer = await openWorkspaceClient(workspace, "operator.write", "writer");
  using admin = await openWorkspaceClient(workspace, "operator.admin", "admin");
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
});

test("sessions.create uses a non-git Gateway cwd directly but not as a worktree source", async () => {
  const cwd = await makeNonGitTempDir("openclaw-session-direct-cwd-");
  const direct = await createSession({ cwd });
  expect(direct.ok).toBe(true);
  expect(direct.payload?.entry?.spawnedCwd).toBe(cwd);

  const isolated = await createSession({ cwd, worktree: true });
  expectInvalid(isolated, "agent workspace is not a git checkout");
});

test("sessions.create keeps its cwd contract absolute-only", async () => {
  const created = await directSessionReq("sessions.create", { cwd: "~/repo" });

  expectInvalid(created, "sessions.create cwd must be absolute");
});

test.each([
  { name: "a dirty checkout", outcome: "dirty" },
  { name: "a concurrently finalized checkout", outcome: "finalized" },
  { name: "a cleanup exception", outcome: "failed" },
] as const)(
  "sessions.create reset-in-place reports cleanup truth for $name",
  async ({ outcome }) => {
    await using fixture = await setupResetWorktree("openclaw-reset-retained-worktree-");
    const { storePath } = fixture;
    using warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const originalRemoveIfLossless = captureMethodCall("removeIfLossless")(
      ManagedWorktreeService.prototype,
    );
    const created = await mainSession({ worktree: true });
    expect(created.ok).toBe(true);
    const worktree = created.payload!.worktree;
    fixture.track(worktree.id);
    const dirtyFile = path.join(worktree.path, "retained-work.txt");
    if (outcome === "dirty") {
      await fs.writeFile(dirtyFile, "preserve my work\n");
    }
    using _ =
      outcome === "dirty"
        ? undefined
        : vi
            .spyOn(ManagedWorktreeService.prototype, "removeIfLossless")
            .mockImplementation(async function (this: ManagedWorktreeService, id) {
              if (outcome === "failed") {
                throw new Error("simulated cleanup failure");
              }
              await originalRemoveIfLossless(this, id);
              return false;
            });

    const reset = await mainSession({}, "operator.write");
    expectDetached(reset);
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
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(expect.any(Number));
      await expect(fs.access(worktree.path)).rejects.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    }
  },
);

test("sessions.create reset-in-place detaches the prior worktree permission boundary", async () => {
  // The template remote makes this a lossless leave-worktree flow.
  await using fixture = await setupResetWorktree("openclaw-reset-session-worktree-", {
    primary: "openai/current-model",
  });
  const { workspace, storePath } = fixture;
  using warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
  const resolved = { modelProvider: "openai", model: "current-model" };
  const created = await mainSession({ worktree: true, permissionMode: "workspace" });
  expect(created).toMatchObject({ ok: true, payload: { key: "agent:main:main" } });
  expect(created.payload?.resolved).toEqual(resolved);
  const worktree = created.payload?.worktree;
  fixture.track(worktree?.id);
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
  const removalGate = createDeferredCore();
  const { promise: removalStarted, resolve: markRemovalStarted } = createDeferredCore();
  using removeIfLosslessSpy = vi
    .spyOn(ManagedWorktreeService.prototype, "removeIfLossless")
    .mockImplementation(async function (this: ManagedWorktreeService, id) {
      if (id === worktree?.id) {
        expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
          targetSessionKey: "agent:main:main",
          reason: "session-reset",
        });
        markRemovalStarted();
        expect(isSessionLifecycleMutationActive(storePath, ["agent:main:main"])).toBe(true);
        await removalGate.promise;
      }
      return await originalRemoveIfLossless(this, id);
    });
  using _ = { [Symbol.dispose]: () => removalGate.resolve() };
  const resetPromise = mainSession({}, "operator.write");
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
  removalGate.resolve();
  const [reset, successor] = await Promise.all([resetPromise, successorPromise]);
  removeIfLosslessSpy.mockRestore();
  expectDetached(reset);
  expect(reset.payload?.entry.permissionMode).toBeUndefined();
  expect(reset.payload?.resolved).toEqual(resolved);
  expect(getRegistryWorktree(process.env, worktree!.id)?.removedAt).toEqual(expect.any(Number));
  await expect(fs.access(worktree!.path)).rejects.toThrow();
  expect(warnSpy).not.toHaveBeenCalled();
  expect(successor.ok).toBe(true);
  const successorWorktree = successor.payload!.worktree;
  expect(successorWorktree.id).not.toBe(worktree?.id);
  fixture.track(successorWorktree.id);
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
});

test("sessions.create rejects worktrees for agent workspaces without a commit", async () => {
  const workspace = await makeNonGitTempDir("openclaw-session-unborn-workspace-");
  await execFileAsync("git", ["init", workspace]);
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const created = await createSession({ agentId: "main", worktree: true });

    expectInvalid(created, expect.stringContaining("git checkout has no commits"));
    expect(created.error?.message).toContain("Create an initial commit, then retry.");
  } finally {
    testState.agentConfig = undefined;
  }
});
