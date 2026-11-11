import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsFilesGetResult } from "../../packages/gateway-protocol/src/index.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { findGitCheckoutRoot } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { managedWorktrees, ManagedWorktreeService } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { isSessionMutationActive } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
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
import { adoptUnboundPullRequestWorkspace } from "./session-pr-workspace-adoption.js";
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
    deviceIdentityPath: path.join(root, name, "client", "credentials.sqlite"),
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
  // Keep the live suite Gateway and direct handlers on the same state root.
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, tempDirs.make(prefix));
  testState.agentConfig = { workspace, ...(model ? { model } : {}) };
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-reset-parent") } });
  const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
  let worktreeId: string | undefined;
  return {
    workspace,
    storePath,
    scope,
    readEntry: () => loadSessionEntry(scope),
    async createWorktree(params: Record<string, unknown> = {}) {
      const created = await mainSession({ worktree: true, ...params });
      expect(created).toMatchObject({ ok: true, payload: { key: "agent:main:main" } });
      worktreeId = created.payload!.worktree.id;
      return created.payload!;
    },
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
    },
  };
}

async function openWorkspaceEditor(fixture: Awaited<ReturnType<typeof setupResetWorktree>>) {
  const { worktree } = await fixture.createWorktree();
  const request = { sessionKey: "agent:main:main", path: "README.md" };
  const options = { client: { connect: { scopes: ["operator.admin"] } } as never };
  const read = () =>
    directSessionReq<SessionsFilesGetResult>("sessions.files.get", request, options);
  const opened = await read();
  expect(opened.ok, JSON.stringify(opened.error)).toBe(true);
  expect(opened.payload).toMatchObject({
    source: { workspaceId: worktree.id },
    file: { content: "base\n" },
  });
  return {
    worktree,
    opened,
    read,
    save(content: string, version = opened.payload!, includeSource = true) {
      return directSessionReq<SessionsFilesGetResult>(
        "sessions.files.set",
        {
          ...request,
          content,
          expectedHash: version.file.hash,
          ...(includeSource ? { expectedSource: version.source } : {}),
        },
        options,
      );
    },
    expectContent: (root: string, content = "base\n") =>
      expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe(content),
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

test("an ordinary session created through a workspace alias can adopt without accepting another cwd", async () => {
  const root = tempDirs.make("openclaw-session-adopt-alias-");
  const workspace = path.join(root, "workspace");
  const alias = path.join(root, "alias");
  const other = path.join(root, "other");
  await fs.mkdir(workspace);
  await fs.mkdir(other);
  await fs.symlink(workspace, alias, directoryLinkType);
  testState.agentConfig = { workspace: alias };
  const { storePath } = await createSessionStoreDir();
  let adoptedId: string | undefined;
  try {
    const ordinary = await createSession({ agentId: "main", worktree: false });
    expect(ordinary.ok, JSON.stringify(ordinary.error)).toBe(true);
    const key = requireNonEmptyString(ordinary.payload?.key, "ordinary session key");
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath })!;
    expect(entry.sessionRoot).toBe(await fs.realpath(workspace));
    expect(entry.spawnedCwd).toBeUndefined();
    const transcript = await SessionManager.openAsync(
      { agentId: "main", sessionKey: key, sessionId: entry.sessionId, storePath },
      alias,
    );
    await transcript.appendMessageAsync(makeUserMessage("Continue this conversation", 1));
    const context = createDirectChatContext();
    const input = {
      context,
      target: { agentId: "main", sessionKey: key, storePath },
      entry,
      sandbox: createSandboxTestContext({
        overrides: { sessionKey: key, workspaceDir: alias, workspaceSource: undefined },
      }),
      assertCurrent() {},
      async verifyBeforeBinding() {},
    };
    const explicit = await createSession({ agentId: "main", cwd: other, worktree: false });
    expect(explicit.ok).toBe(true);
    const explicitKey = requireNonEmptyString(explicit.payload?.key, "explicit session key");
    await expect(
      adoptUnboundPullRequestWorkspace({
        ...input,
        target: { ...input.target, sessionKey: explicitKey },
        entry: loadSessionEntry({ agentId: "main", sessionKey: explicitKey, storePath })!,
      }),
    ).rejects.toThrow("already has another source");
    await fs.unlink(alias);
    await fs.symlink(other, alias, directoryLinkType);
    await expect(adoptUnboundPullRequestWorkspace(input)).rejects.toThrow(
      "already has another source",
    );
    await fs.unlink(alias);
    await fs.symlink(workspace, alias, directoryLinkType);
    const adopted = await adoptUnboundPullRequestWorkspace(input);
    adoptedId = adopted.worktree?.id;
    expect(adoptedId).toBeDefined();
    expect(adopted.priorWorkspace).toMatchObject({ workspaceDir: alias, fileRoot: alias });
  } finally {
    if (adoptedId) {
      await managedWorktrees.remove({
        id: adoptedId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    testState.agentConfig = undefined;
  }
});

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
  expectInvalid(isolated, `requested working directory is not a git checkout: ${cwd}`);
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
    using warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const originalRemoveIfLossless = captureMethodCall("removeIfLossless")(
      ManagedWorktreeService.prototype,
    );
    const { worktree } = await fixture.createWorktree();
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
    expect(fixture.readEntry()?.worktree).toBeUndefined();
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
  const { workspace, storePath, scope } = fixture;
  using warnSpy = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
  const resolved = { modelProvider: "openai", model: "current-model" };
  const created = await fixture.createWorktree({ permissionMode: "workspace" });
  expect(created.resolved).toEqual(resolved);
  const { worktree } = created;
  expect(created.entry).toMatchObject({
    spawnedCwd: worktree.path,
    sessionRoot: worktree.path,
    permissionMode: "workspace",
  });
  expect(fixture.readEntry()?.spawnedCwd).toBe(worktree.path);

  const priorWorkspace = {
    worktreeId: worktree!.id,
    sessionId: created.entry.sessionId,
    workspaceDir: workspace,
    fileRoot: workspace,
    through: { generation: "before-adoption", maxSeq: 1 },
  };
  await upsertSessionEntryCore(scope, { ...fixture.readEntry()!, priorWorkspace });
  const ordinaryReset = await directSessionReq("sessions.reset", {
    key: scope.sessionKey,
    reason: "reset",
  });
  expect(ordinaryReset.ok).toBe(true);
  expect(fixture.readEntry()?.priorWorkspace).toEqual(priorWorkspace);

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
        expect(isSessionMutationActive(storePath, ["agent:main:main"])).toBe(true);
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
  expect(fixture.readEntry()).toMatchObject({
    spawnedCwd: successorWorktree.path,
    worktree: {
      id: successorWorktree.id,
      branch: successorWorktree.branch,
      repoRoot: workspace,
    },
  });
  expect(getRegistryWorktree(process.env, successorWorktree.id)?.removedAt).toBeUndefined();
  expect(fixture.readEntry()?.priorWorkspace).toBeUndefined();
});

test("an open Files editor cannot save into a replacement managed workspace", async () => {
  await using fixture = await setupResetWorktree("openclaw-files-source-reset-");
  const editor = await openWorkspaceEditor(fixture);
  const staleSave = () => editor.save("draft from the original workspace\n");
  const sourceChanged = { error: { details: { type: "session_file_source_changed" } } };

  expectDetached(await mainSession({}, "operator.write"));
  await expect(staleSave()).rejects.toMatchObject(sourceChanged);
  await editor.expectContent(fixture.workspace);
  const { worktree: current } = await fixture.createWorktree();
  expect(current.id).not.toBe(editor.worktree.id);
  await expect(staleSave()).rejects.toMatchObject(sourceChanged);
  await editor.expectContent(current.path);

  const fresh = await editor.read();
  expect(fresh.payload).toMatchObject({
    source: { workspaceId: current.id },
    file: { content: "base\n" },
  });
  const saved = await editor.save("fresh edit\n", fresh.payload!);
  expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
  expect(saved.payload?.source?.workspaceId).toBe(current.id);
  await editor.expectContent(current.path, "fresh edit\n");
  const legacy = await editor.save("legacy client edit\n", saved.payload!, false);
  expect(legacy.ok, JSON.stringify(legacy.error)).toBe(true);
  await editor.expectContent(current.path, "legacy client edit\n");
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

test("an explicit cwd reset refuses the previous managed file source", async () => {
  await using fixture = await setupResetWorktree("openclaw-files-explicit-cwd-");
  const editor = await openWorkspaceEditor(fixture);
  const { worktree: original, opened } = editor;
  const replacement = path.join(fixture.workspace, "replacement");
  await fs.mkdir(replacement);
  await fs.writeFile(path.join(replacement, "README.md"), "base\n");
  const reset = await mainSession({ cwd: replacement });
  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(reset.payload?.entry.spawnedCwd).toBe(replacement);
  expect(reset.payload?.entry.worktree?.id).toBe(original.id);
  const fresh = await editor.read();
  expect(fresh.payload).toMatchObject({
    source: { workspaceId: original.id },
    file: { content: "base\n" },
  });
  await expect(editor.save("draft from A\n")).rejects.toMatchObject({
    error: { details: { type: "session_file_source_changed" } },
  });
  await editor.expectContent(replacement);
  expect(fresh.payload?.source).not.toEqual(opened.payload?.source);
  const saved = await editor.save("fresh edit in B\n", fresh.payload!);
  expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
  await editor.expectContent(replacement, "fresh edit in B\n");
});
