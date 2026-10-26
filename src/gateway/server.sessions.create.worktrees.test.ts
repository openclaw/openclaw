import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  findLiveRegistryWorktreeByOwner,
  getRegistryWorktree,
} from "../agents/worktrees/registry.test-support.js";
import { managedWorktrees, ManagedWorktreeService } from "../agents/worktrees/service.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { isSessionMutationActive } from "../sessions/session-controller.lifecycle.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { soloClient } from "./server-methods/sessions-sharing.test-support.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateTestHarness,
  sessionDiffBaselineMocks,
  chatSendOwner,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { agentCommandMock, mockGetReplyFromConfigOnce, rpcReq, testState } from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";
import { getGatewayConfigModule, directSessionReq } from "./test/server-sessions.test-helpers.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness(async (makeTempDir) => {
  gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
});
const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args]);
const createWorkspace = (prefix: string) =>
  copyGitWorkspace(gitWorkspaceTemplate, tempDirs.make(prefix));
const adminOptions = { client: { connect: { scopes: ["operator.admin"] } } as never };
const createSession = (
  params: Record<string, unknown>,
  options: Parameters<typeof directSessionReq<SessionsCreateResult>>[2] = adminOptions,
) =>
  directSessionReq<SessionsCreateResult>(
    "sessions.create",
    { agentId: "main", ...params },
    options,
  );

async function removeLiveWorktree(id?: string) {
  if (id && getRegistryWorktree(process.env, id)?.removedAt === undefined) {
    await managedWorktrees.remove({ id, reason: "test-cleanup", allowSnapshotLoss: true });
  }
}

test("sessions.create fences the first workspace write behind its diff baseline", async () => {
  const workspace = await createWorkspace("openclaw-session-diff-first-write-");
  await fs.appendFile(path.join(workspace, "README.md"), "dirty before session\n");
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:diff-first-write";
  const captureStarted = createDeferredCore();
  const releaseCapture = createDeferredCore();
  sessionDiffBaselineMocks.captureStarted = captureStarted.resolve;
  sessionDiffBaselineMocks.captureGate = releaseCapture.promise;
  sessionDiffBaselineMocks.useReal = true;

  const { ensureSessionDiffBaseline } = await import("../sessions/session-diff-baseline.js");
  let firstTurn: Promise<void> | undefined;
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "diff-first-write-run", status: "started" });
    firstTurn = (async () => {
      const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
      if (!entry) {
        throw new Error("expected the precreated session entry");
      }
      await ensureSessionDiffBaseline({
        agentId: "main",
        cwd: workspace,
        entry,
        isNewSession: false,
        sessionKey,
        storePath,
      });
      await fs.writeFile(path.join(workspace, "first-turn.txt"), "written by first turn\n");
    })();
  });
  const client = {
    client: {
      connect: {
        scopes: ["operator.admin", "operator.write"],
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      },
    } as never,
  };

  try {
    const created = await createSession(
      { cwd: workspace, key: sessionKey, message: "write a file" },
      client,
    );
    expect(created).toMatchObject({
      ok: true,
      payload: { runStarted: true, sessionId: expect.any(String) },
    });
    expect(created.payload).not.toHaveProperty("entry.sessionDiffBaselineCapture");
    await captureStarted.promise;
    await expect(fs.stat(path.join(workspace, "first-turn.txt"))).rejects.toThrow();

    releaseCapture.resolve();
    await firstTurn;
    const diff = await directSessionReq<{ files?: Array<{ path: string }> }>(
      "sessions.diff",
      { sessionKey },
      client,
    );
    expect(diff.ok, JSON.stringify(diff.error)).toBe(true);
    expect(diff.payload?.files?.map((file) => file.path)).toEqual(["first-turn.txt"]);
  } finally {
    releaseCapture.resolve();
    await firstTurn?.catch(() => undefined);
    sessionDiffBaselineMocks.captureGate = undefined;
    sessionDiffBaselineMocks.captureStarted = undefined;
    sessionDiffBaselineMocks.useReal = false;
    chatSend.mockRestore();
  }
});

test("sessions.create rolls back failed provisioning before a same-key creator proceeds", async () => {
  const workspace = await createWorkspace("openclaw-session-worktree-rollback-");
  testState.agentConfig = { workspace };
  testState.sessionConfig = { sharing: { drafts: false } };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:worktree-rollback";
  const originalRollback = captureMethodCall("rollbackPreparation")(
    ManagedWorktreeService.prototype,
  );
  let failedWorktreeId: string | undefined;
  let successorWorktreeId: string | undefined;
  const { promise: rollbackGate, resolve: releaseRollback } = createDeferredCore();
  const { promise: rollbackStarted, resolve: markRollbackStarted } = createDeferredCore();
  const rollbackSpy = vi
    .spyOn(ManagedWorktreeService.prototype, "rollbackPreparation")
    .mockImplementation(async function (this: ManagedWorktreeService, record, withRollback) {
      failedWorktreeId = record.id;
      markRollbackStarted();
      expect(isSessionMutationActive(storePath, [key])).toBe(true);
      await rollbackGate;
      await originalRollback(this, record, withRollback);
    });
  try {
    const failedPromise = createSession({ key, visibility: "draft", worktree: true });
    await Promise.race([
      rollbackStarted,
      failedPromise.then((result) => {
        throw new Error(`Creation returned before rollback started: ${JSON.stringify(result)}`);
      }),
    ]);
    let successorSettled = false;
    const successorPromise = createSession({ key, worktree: true }).then((result) => {
      successorSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(successorSettled).toBe(false);

    releaseRollback();
    const [failed, successor] = await Promise.all([failedPromise, successorPromise]);
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "session visibility is disabled: draft",
        details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" },
      },
    });
    expect(failedWorktreeId).toBeTruthy();
    expect(getRegistryWorktree(process.env, failedWorktreeId!)).toMatchObject({
      removedAt: expect.any(Number),
    });
    expect(successor.ok).toBe(true);
    const successorWorktree = successor.payload!.worktree!;
    successorWorktreeId = successorWorktree.id;
    expect(successorWorktree.id).not.toBe(failedWorktreeId);
    await fs.access(successorWorktree.path);
    expect(loadSessionEntry({ sessionKey: key, storePath })?.worktree).toEqual({
      id: successorWorktree.id,
      branch: successorWorktree.branch,
      repoRoot: workspace,
      canonicalWorkspaceDir: workspace,
    });

    const adoptedFailure = await createSession({ key, visibility: "draft", worktree: true });
    expect(adoptedFailure).toMatchObject({
      ok: false,
      error: { message: "sessions.create visibility requires a new session" },
    });
    expect(rollbackSpy.mock.calls.some(([record]) => record.id === successorWorktree.id)).toBe(
      false,
    );
    expect(getRegistryWorktree(process.env, successorWorktree.id)?.removedAt).toBeUndefined();
  } finally {
    releaseRollback();
    rollbackSpy.mockRestore();
    await removeLiveWorktree(successorWorktreeId);
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
  }
});

test.each([
  { source: "repository", change: "restore" },
  { source: "repository", change: "remove" },
  { source: "empty", change: "restore" },
  { source: "empty", change: "remove" },
] as const)(
  "sessions.create rolls back only its own allocation after concurrent $source worktree $change",
  async ({ source, change }) => {
    const root = tempDirs.make("openclaw-session-worktree-allocation-outcome-");
    const workspace = await copyGitWorkspace(gitWorkspaceTemplate, root);
    const disk = fsSync.statfsSync(root);
    const diskSpace = vi.spyOn(fsSync, "statfsSync").mockReturnValue({
      type: disk.type,
      files: disk.files,
      frsize: disk.frsize,
      ffree: disk.ffree,
      bsize: 4096,
      blocks: 1024 ** 4 / 4096,
      bavail: (100 * 1024 ** 3) / 4096,
      bfree: (100 * 1024 ** 3) / 4096,
    });
    const key = "agent:main:dashboard:worktree-allocation-outcome";
    const owner = { ownerKind: "session" as const, ownerId: key, name: "allocation-outcome" };
    const worktree =
      source === "empty"
        ? await managedWorktrees.createEmpty(owner)
        : await managedWorktrees.create({ ...owner, repoRoot: workspace });
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "Keep the restored checkout.\n");
    if (change === "restore") {
      await managedWorktrees.remove({ id: worktree.id, reason: "manual-delete" });
    }
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = { workspace };
    testState.sessionConfig = { sharing: { drafts: false } };
    const cfg = loadGatewayTestConfig();
    (await getGatewayConfigModule()).setRuntimeConfigSnapshot(cfg);
    const entered = createDeferredCore();
    const proceed = createDeferredCore();
    const beforeAllocation = async () => {
      entered.resolve();
      await proceed.promise;
    };
    const create = captureMethodCall("createWithOutcome")(ManagedWorktreeService.prototype);
    const createEmpty = captureMethodCall("createEmptyWithOutcome")(
      ManagedWorktreeService.prototype,
    );
    const createSpy = vi
      .spyOn(ManagedWorktreeService.prototype, "createWithOutcome")
      .mockImplementationOnce(async function (this: ManagedWorktreeService, params) {
        await beforeAllocation();
        return await create(this, params);
      });
    const createEmptySpy = vi
      .spyOn(ManagedWorktreeService.prototype, "createEmptyWithOutcome")
      .mockImplementationOnce(async function (this: ManagedWorktreeService, params) {
        await beforeAllocation();
        return await createEmpty(this, params);
      });
    const client = soloClient();
    client.connect.scopes = ["operator.admin"];
    const creation = createSession(
      {
        key,
        visibility: "draft",
        worktree: true,
        worktreeName: owner.name,
        ...(source === "empty" ? { worktreeSource: "empty" } : {}),
      },
      { client, context: { getRuntimeConfig: () => cfg } },
    );
    try {
      await Promise.race([
        entered.promise,
        creation.then((result) => {
          throw new Error(`Creation returned before allocation: ${JSON.stringify(result)}`);
        }),
      ]);
      if (change === "restore") {
        await managedWorktrees.restore({ id: worktree.id });
      } else {
        await managedWorktrees.remove({ id: worktree.id, reason: "manual-delete" });
      }
      proceed.resolve();
      await expect(creation).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "session visibility is disabled: draft" },
      });
      expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
      const record = getRegistryWorktree(process.env, worktree.id);
      if (change === "restore") {
        expect(record?.removedAt).toBeUndefined();
        await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
          "Keep the restored checkout.\n",
        );
      } else {
        expect(record?.removedAt).toEqual(expect.any(Number));
        await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await git(worktree.repoRoot, "show", `${record!.snapshotRef}:draft.txt`)).stdout,
        ).toBe("Keep the restored checkout.\n");
      }
    } finally {
      proceed.resolve();
      await Promise.allSettled([creation]);
      createSpy.mockRestore();
      createEmptySpy.mockRestore();
      await removeLiveWorktree(worktree.id);
      diskSpace.mockRestore();
      await disposeSessionReadContexts();
      testState.agentConfig = undefined;
      testState.sessionConfig = undefined;
    }
  },
);

test("sessions.create runs an existing managed worktree cwd for initial and follow-up turns", async () => {
  const root = tempDirs.make("openclaw-session-existing-worktree-cwd-");
  const workspace = await copyGitWorkspace(gitWorkspaceTemplate, root);
  testState.agentsConfig = {
    entries: { main: {}, roboclaw: { workspace } },
  };
  const { dir, storePath } = await createSessionStoreDir();
  const worktree = await managedWorktrees.create({
    repoRoot: workspace,
    ownerKind: "manual",
    name: "roboclaw-existing-worktree",
    runSetupScript: false,
  });
  const requestedCwd = await fs.realpath(worktree.path);
  const { prepareAgentCommandExecution } = await import("../agents/command/prepare.js");
  const actualConfigIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  const { resolveIngressWorkspaceOverrideForSessionRun } =
    await import("../agents/spawned-context.js");
  const acpManagerModule = await import("../acp/control-plane/manager.js");
  const getAcpSessionManager = vi
    .spyOn(acpManagerModule, "getAcpSessionManager")
    .mockReturnValue({ resolveSessionAsync: async () => null } as never);
  const { defaultRuntime } = await import("../runtime.js");
  const prepareInitialRun = createDeferredCore();
  const preparedRuntime = vi.fn<(params: { cwd?: string; workspaceDir?: string }) => void>();
  const mockPreparedRuntime = () =>
    mockGetReplyFromConfigOnce(async (ctx, opts) => {
      await prepareInitialRun.promise;
      const sessionKey = requireNonEmptyString(ctx.SessionKey, "prepared session key");
      const loaded = loadSessionEntry({ agentId: "roboclaw", sessionKey, storePath });
      const workspaceDir =
        resolveIngressWorkspaceOverrideForSessionRun({
          spawnedBy: loaded?.spawnedBy,
          workspaceDir: loaded?.spawnedWorkspaceDir,
          cwd: loaded?.spawnedCwd,
        }) ?? workspace;
      const prepared = await prepareAgentCommandExecution(
        {
          agentId: "roboclaw",
          message: "exercise the prepared runtime cwd",
          runId: opts?.runId,
          sessionKey,
          workspaceDir,
        },
        defaultRuntime,
      );
      const terminalPersisted = createDeferredCore();
      const stopTerminalObserver = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey) {
          const entry = loadSessionEntry({ agentId: "roboclaw", sessionKey, storePath });
          if (entry?.status === "done" && entry.lastRunId === prepared.runId) {
            terminalPersisted.resolve();
          }
        }
      });
      try {
        opts?.onSessionPrepared?.({
          sessionKey: prepared.sessionKey,
          sessionId: prepared.sessionId,
          storePath: prepared.storePath,
          lifecycleRevision: prepared.sessionEntry?.lifecycleRevision,
        });
        opts?.onAgentRunStart?.(prepared.runId);
        // Completed mock turns must settle the same recovery custody as the real runtime.
        const lifecycle = {
          runId: prepared.runId,
          sessionKey: prepared.sessionKey,
          sessionId: prepared.sessionId,
          agentId: prepared.sessionAgentId,
        };
        const startedAt = Date.now();
        emitAgentEvent({ ...lifecycle, stream: "lifecycle", data: { phase: "start", startedAt } });
        preparedRuntime({ cwd: prepared.cwd, workspaceDir: prepared.workspaceDir });
        emitAgentEvent({
          ...lifecycle,
          stream: "lifecycle",
          data: { phase: "end", startedAt, endedAt: Date.now() },
        });
        await terminalPersisted.promise;
      } finally {
        stopTerminalObserver();
        await prepared.runLease?.release();
      }
      return { text: "ok" };
    });
  const { ws } = await openClient({
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(root, "roboclaw-device", "client", "credentials.sqlite"),
  });

  try {
    mockPreparedRuntime();
    const created = await rpcReq<SessionsCreateResult>(ws, "sessions.create", {
      agentId: "roboclaw",
      cwd: requestedCwd,
      permissionMode: "full",
      task: "start in the existing worktree",
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry).toMatchObject({
      spawnedCwd: requestedCwd,
      sessionRoot: requestedCwd,
      permissionMode: "full",
    });
    expect(created.payload?.runStarted).toBe(true);
    const sessionKey = requireNonEmptyString(created.payload?.key, "roboclaw session key");
    const sessionId = requireNonEmptyString(created.payload?.sessionId, "roboclaw session id");
    await expect(
      loadTranscriptEvents({
        agentId: "roboclaw",
        sessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toContainEqual(expect.objectContaining({ cwd: requestedCwd, type: "session" }));
    const createRunId = requireNonEmptyString(created.payload?.runId, "roboclaw create run id");
    const pendingCreateWait = rpcReq(ws, "agent.wait", { runId: createRunId, timeoutMs: 10_000 });
    // Real-IO readers can run after the RPC fixture refresh, before the admitted turn
    // prepares. They must see the same roster as creation, not pin the disk-only config.
    actualConfigIo.getRuntimeConfig();
    prepareInitialRun.resolve();
    const createWait = await pendingCreateWait;
    expect(createWait, JSON.stringify(createWait)).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
    expect(preparedRuntime).toHaveBeenCalledTimes(1);
    expect(preparedRuntime.mock.calls[0]?.[0]).toEqual({
      cwd: requestedCwd,
      workspaceDir: requestedCwd,
    });

    preparedRuntime.mockClear();
    mockPreparedRuntime();
    const followup = await rpcReq<{ runId?: string }>(ws, "sessions.send", {
      key: sessionKey,
      message: "continue in the existing worktree",
      idempotencyKey: "roboclaw-existing-worktree-followup",
    });
    expect(followup.ok, JSON.stringify(followup.error)).toBe(true);
    const followupRunId = requireNonEmptyString(followup.payload?.runId, "follow-up run id");
    const followupWait = await rpcReq(ws, "agent.wait", {
      runId: followupRunId,
      timeoutMs: 10_000,
    });
    expect(followupWait, JSON.stringify(followupWait)).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
    expect(preparedRuntime).toHaveBeenCalledTimes(1);
    expect(preparedRuntime.mock.calls[0]?.[0]).toEqual({
      cwd: requestedCwd,
      workspaceDir: requestedCwd,
    });

    const commandEntered = createDeferredCore();
    agentCommandMock.mockClear();
    agentCommandMock.mockImplementationOnce(async () => commandEntered.resolve());
    const run = await rpcReq(ws, "agent", {
      message: "verify worktree cwd",
      sessionKey,
      idempotencyKey: "session-worktree-cwd",
    });
    expect(run.ok, JSON.stringify(run)).toBe(true);
    await commandEntered.promise;
    expect(agentCommandMock.mock.calls.at(-1)?.[0]).toMatchObject({
      cwd: requestedCwd,
      workspaceDir: requestedCwd,
    });
  } finally {
    prepareInitialRun.resolve();
    ws.close();
    getAcpSessionManager.mockRestore();
    await managedWorktrees.remove({
      id: worktree.id,
      reason: "test-cleanup",
      allowSnapshotLoss: true,
    });
    await disposeSessionReadContexts();
    await releaseGatewaySessionStoreFixture(dir);
    testState.agentsConfig = undefined;
  }
});

test("sessions.create preserves pending worktree intent when initial-turn admission fails", async () => {
  const workspace = await createWorkspace("openclaw-session-worktree-post-commit-failure-");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:post-commit-worktree";
  try {
    const created = await createSession({
      key,
      message: "reject this initial input\u0000",
      worktree: true,
      worktreeName: "post-commit-worktree",
    });
    expect(created).toMatchObject({
      ok: true,
      payload: {
        key,
        runError: {
          code: "INVALID_REQUEST",
          message: "message must not contain null bytes",
        },
        runStarted: false,
        sessionId: expect.any(String),
      },
    });

    expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
      sessionId: expect.any(String),
      pendingWorktree: { name: "post-commit-worktree", workspace },
    });
    expect(findLiveRegistryWorktreeByOwner(process.env, "session", key)).toBeUndefined();
  } finally {
    await disposeSessionReadContexts();
    testState.agentConfig = undefined;
  }
});
