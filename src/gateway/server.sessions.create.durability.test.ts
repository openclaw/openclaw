import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  recoverRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { readLoggingConfig } from "../logging/config.js";
import { applyLoggingConfig } from "../logging/logger.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import type { StartChatDispatchParams } from "./server-methods/chat-send-agent-dispatch.types.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createGitWorkspace } from "./server.sessions.create.projects.test-support.js";
import {
  chatSendOwner,
  dashboardTitleScheduleMocks,
  setupSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { agentCommandMock, rpcReq, testState } from "./test-helpers.js";

const dispatch = vi.hoisted(() => ({ start: vi.fn<(params: StartChatDispatchParams) => void>() }));
const turnBoundary = vi.hoisted(() => ({
  committing: false,
  afterPrepare: undefined as (() => void) | undefined,
  afterCommit: undefined as (() => void) | undefined,
}));
vi.mock("../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  const committing = command.type === "session.turn.commit";
                  if (committing) {
                    turnBoundary.committing = true;
                  }
                  try {
                    const result = await worker.execute(command, commandOptions);
                    if (command.type === "session.turn.prepare") {
                      turnBoundary.afterPrepare?.();
                    }
                    if (committing) {
                      turnBoundary.afterCommit?.();
                    }
                    return result;
                  } finally {
                    if (committing) {
                      turnBoundary.committing = false;
                    }
                  }
                },
              }),
            options,
          ),
      };
    },
  };
});
vi.mock("./server-methods/chat-send-agent-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-send-agent-dispatch.js")>()),
  startChatDispatch: dispatch.start,
}));
let workspace: string;
const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness(async (makeTempDir) => {
  workspace = await createGitWorkspace(makeTempDir("openclaw-initial-turn-durability-"));
});

afterEach(() => {
  turnBoundary.committing = false;
  turnBoundary.afterPrepare = undefined;
  turnBoundary.afterCommit = undefined;
  vi.restoreAllMocks();
});

test.for([
  "before-input",
  "after-preparation",
  "transaction-refused",
  "commit-refused",
  "revoked-after-preparation",
  "permission-revoked-at-commit",
] as const)(
  "keeps only the created session when fresh input fails at %s",
  async (fault, { signal }) => {
    const { storePath } = await createSessionStoreDir();
    let { ws } = await openClient();
    const key = `agent:main:dashboard:initial-failure-${fault}`;
    const message = "Only retain this initial input after its restart claim commits.";
    const target = { agentId: "main", sessionKey: key, storePath };
    const failure = new Error(`initial input ${fault}`);
    let initial: GatewayRequestHandlerOptions | undefined;
    const initialSettled = createDeferred();
    const hit = vi.fn();
    const send = chatSendOwner.handleDirectExternalChatSend;
    const intercept = vi
      .spyOn(chatSendOwner, "handleDirectExternalChatSend")
      .mockImplementation(async (options) => {
        if (options.params.sessionKey === key) {
          initial = options;
          if (fault === "before-input") {
            hit();
            throw failure;
          }
        }
        try {
          await send(options);
        } finally {
          if (options.params.sessionKey === key) {
            initialSettled.resolve();
          }
        }
      });
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const refuse = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          if (
            fault === "permission-revoked-at-commit" &&
            turnBoundary.committing &&
            request.stage === "commit"
          ) {
            hit();
            const options = expectDefined(initial, "initial request");
            invalidateGatewayDeviceRevocation(
              options.context,
              expectDefined(options.client?.connect.device?.id, "authenticated device"),
              "operator",
            );
          }
          if (
            turnBoundary.committing &&
            ((fault === "transaction-refused" && request.stage === "transaction") ||
              (fault === "commit-refused" && request.stage === "commit"))
          ) {
            hit();
            throw failure;
          }
          callback(request, grant);
        }, attachment),
      );
    if (fault === "after-preparation" || fault === "revoked-after-preparation") {
      turnBoundary.afterPrepare = () => {
        turnBoundary.afterPrepare = undefined;
        hit();
        if (fault === "after-preparation") {
          throw failure;
        }
        const options = expectDefined(initial, "initial request");
        const runId = String(options.params.idempotencyKey);
        const run = expectDefined(options.context.chatAbortControllers.get(runId), "admitted run");
        run.abortStopReason = "restart";
        run.controller.abort(failure);
      };
    }
    dispatch.start.mockClear();
    dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
    try {
      const params = { agentId: "main", key, message };
      let created:
        | { ok: boolean; payload?: { sessionId: string; runStarted: boolean } | null }
        | undefined;
      if (fault === "permission-revoked-at-commit") {
        // Revocation suppresses this request's wire response. Join its real handler
        // and native settlement instead of waiting for an intentionally absent ACK.
        const responses: unknown[] = [];
        const requestId = "revoked-create";
        const onMessage = (raw: unknown) => responses.push(JSON.parse(String(raw)));
        ws.on("message", onMessage);
        try {
          ws.send(
            JSON.stringify({ type: "req", id: requestId, method: "sessions.create", params }),
          );
          await withinTest(initialSettled.promise, signal);
          await getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
          const closed = once(ws, "close");
          ws.close();
          await withinTest(closed, signal);
          expect(responses).not.toContainEqual(
            expect.objectContaining({
              type: "res",
              id: requestId,
              ok: true,
              payload: expect.objectContaining({ runStarted: true }),
            }),
          );
        } finally {
          ws.off("message", onMessage);
        }
        ({ ws } = await openClient());
      } else {
        created = await rpcReq<{ sessionId: string; runStarted: boolean }>(
          ws,
          "sessions.create",
          params,
        );
        expect(created.ok, JSON.stringify(created)).toBe(true);
        expect(created.payload?.runStarted).toBe(false);
      }
      expect(hit).toHaveBeenCalledOnce();
      expect(dispatch.start).not.toHaveBeenCalled();
      const before = expectDefined(loadSessionEntry(target), "committed session creation");
      if (created?.payload) {
        expect(before.sessionId).toBe(created.payload.sessionId);
      }
      expect(before.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(before.restartRecoveryDeliverySourceRunId).toBeUndefined();
      const scope = { ...target, sessionId: before.sessionId };
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      expect(await loadTranscriptEvents(scope)).toEqual([
        expect.objectContaining({ type: "session", id: before.sessionId }),
      ]);
      const described = await rpcReq<{ sessionId: string }>(ws, "sessions.describe", {
        key,
        agentId: "main",
      });
      expect(described.ok, JSON.stringify(described)).toBe(true);

      // Same source identity remains retryable: no ACK transferred custody before the failure.
      refuse.mockRestore();
      intercept.mockRestore();
      const runId = String(expectDefined(initial, "initial request").params.idempotencyKey);
      const retry = await rpcReq<{ status: string }>(ws, "chat.send", {
        sessionKey: key,
        message,
        idempotencyKey: runId,
      });
      expect(retry.ok, JSON.stringify(retry)).toBe(true);
      expect(retry.payload?.status).toBe("started");
      expect(loadSessionEntry(target)).toMatchObject({
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
      });
      expect(
        (await loadTranscriptEvents(scope)).filter((event) =>
          JSON.stringify(event).includes(message),
        ),
      ).toHaveLength(1);
      expect(dispatch.start).toHaveBeenCalledOnce();
    } finally {
      turnBoundary.afterPrepare = undefined;
      refuse.mockRestore();
      intercept.mockRestore();
      const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      await released;
      ws.close();
    }
  },
);

test.for(["lost-worker-response", "restart-before-ack"] as const)(
  "retains exactly one recoverable initial turn after %s",
  async (fault) => {
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openClient();
    const key = `agent:main:dashboard:initial-committed-${fault}`;
    const message = "Recover this committed initial input exactly once.";
    const target = { agentId: "main", sessionKey: key, storePath };
    let initial: GatewayRequestHandlerOptions | undefined;
    const send = chatSendOwner.handleDirectExternalChatSend;
    const intercept = vi
      .spyOn(chatSendOwner, "handleDirectExternalChatSend")
      .mockImplementation(async (options) => {
        if (options.params.sessionKey === key) {
          initial = options;
        }
        await send(options);
      });
    const hit = vi.fn();
    const stop = onSessionTranscriptUpdate((update) => {
      if (
        fault !== "restart-before-ack" ||
        update.target.sessionKey !== key ||
        hit.mock.calls.length
      ) {
        return;
      }
      const options = expectDefined(initial, "initial request");
      const runId = String(options.params.idempotencyKey);
      const entry = loadSessionEntry(target);
      if (entry?.restartRecoveryDeliveryRunId !== runId) {
        return;
      }
      hit();
      const run = expectDefined(options.context.chatAbortControllers.get(runId), "committed run");
      run.abortStopReason = "restart";
      run.controller.abort();
    });
    if (fault === "lost-worker-response") {
      turnBoundary.afterCommit = () => {
        turnBoundary.afterCommit = undefined;
        hit();
        throw new Error("Native turn committed but its command response was lost");
      };
    }
    dispatch.start.mockClear();
    dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
    agentCommandMock.mockImplementation(async (raw) => {
      const options = raw as AgentCommandGatewayIngressOpts;
      await options.userTurnTranscriptRecorder?.persistApproved();
    });
    try {
      const created = await rpcReq<{ sessionId: string; runStarted: boolean }>(
        ws,
        "sessions.create",
        {
          agentId: "main",
          key,
          message,
        },
      );
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.payload?.runStarted).toBe(fault === "lost-worker-response");
      expect(hit).toHaveBeenCalledOnce();
      const options = expectDefined(initial, "initial request");
      const runId = String(options.params.idempotencyKey);
      const before = expectDefined(loadSessionEntry(target), "committed initial turn");
      expect(before).toMatchObject({
        sessionId: created.payload?.sessionId,
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
      });
      const scope = { ...target, sessionId: before.sessionId };
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      await released;
      const cfg = getRuntimeConfig();
      await markStartupOrphanedMainSessionsForRecovery({ cfg });
      const recover = () =>
        recoverRestartAbortedMainSessions({
          cfg,
          gatewayRuntime: expectDefined(options.context.recoveryRuntime, "Gateway recovery owner"),
        });
      if (fault === "restart-before-ack") {
        // An unadopted turn is retryable, not automatic execution authority.
        expect(await recover()).toMatchObject({ settled: 0, failed: 0 });
        expect(agentCommandMock).not.toHaveBeenCalled();
        options.context.dedupe.delete(`chat:${runId}`);
        const retried = await rpcReq<{ status: string }>(ws, "chat.send", {
          sessionKey: key,
          message,
          idempotencyKey: runId,
        });
        expect(retried.ok, JSON.stringify(retried)).toBe(true);
        expect(retried.payload?.status).toBe("started");
        expect(dispatch.start).toHaveBeenCalledOnce();
        const retriedRelease = getSessionWorkAdmissionRelease({
          scope: storePath,
          identities: [key],
        });
        const [turn] = dispatch.start.mock.calls[0]!;
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(runId, turn.admission.lifecycleGeneration);
        await retriedRelease;
        await markStartupOrphanedMainSessionsForRecovery({ cfg });
      }
      const recovered = await recover();
      expect(recovered).toMatchObject({ settled: 1, failed: 0 });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(
        (await loadTranscriptEvents(scope)).filter((event) =>
          JSON.stringify(event).includes(message),
        ),
      ).toHaveLength(1);
      const retry = await rpcReq<{ status: string }>(ws, "chat.send", {
        sessionKey: key,
        message,
        idempotencyKey: runId,
      });
      expect(retry.ok, JSON.stringify(retry)).toBe(true);
      expect(retry.payload?.status).toBe("ok");
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(
        (await loadTranscriptEvents(scope)).filter((event) =>
          JSON.stringify(event).includes(message),
        ),
      ).toHaveLength(1);
    } finally {
      turnBoundary.afterCommit = undefined;
      stop();
      intercept.mockRestore();
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      ws.close();
    }
  },
);

test("retains idle chat input custody when its separate transcript commit is refused", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  const key = "agent:main:dashboard:idle-staging-preserved";
  const message = "Idle input keeps its separately accepted bytes.";
  const runId = "idle-staging-preserved";
  const target = { agentId: "main", sessionKey: key, storePath };
  dispatch.start.mockClear();
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const refused = vi.fn();
  const refuse = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      createAdmission((request, grant) => {
        if (turnBoundary.committing && request.stage === "commit") {
          refused();
          throw new Error("Idle transcript commit refused");
        }
        callback(request, grant);
      }, attachment),
    );
  try {
    const created = await rpcReq<{ sessionId: string }>(ws, "sessions.create", {
      agentId: "main",
      key,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const sent = await rpcReq(ws, "chat.send", { sessionKey: key, message, idempotencyKey: runId });
    expect(sent.ok).toBe(false);
    await getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
    expect(refused).toHaveBeenCalledOnce();
    expect(dispatch.start).not.toHaveBeenCalled();
    const entry = expectDefined(loadSessionEntry(target), "idle session");
    expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
    const scope = { ...target, sessionId: entry.sessionId };
    const pending = await listSessionPendingInputs(scope);
    expect(pending).toMatchObject({ total: 1, items: [{ state: "interrupted" }] });
    expect(JSON.stringify(pending.items)).toContain(message);
    expect(
      (await loadTranscriptEvents(scope)).filter((event) =>
        JSON.stringify(event).includes(message),
      ),
    ).toHaveLength(0);
  } finally {
    refuse.mockRestore();
    ws.close();
  }
});

test("dispatches the canonical redacted bytes of a committed initial input", async () => {
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  const key = "agent:main:dashboard:initial-redaction";
  const message = "Check initial-secret before execution.";
  const previousLogging = readLoggingConfig();
  dispatch.start.mockClear();
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  applyLoggingConfig({ redactPatterns: ["initial-secret"] });
  try {
    const created = await rpcReq<{ sessionId: string; runStarted: boolean }>(
      ws,
      "sessions.create",
      {
        agentId: "main",
        key,
        message,
      },
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.payload?.runStarted).toBe(true);
    const turn = expectDefined(dispatch.start.mock.calls[0]?.[0], "admitted initial dispatch");
    const persisted = expectDefined(
      turn.userTurn.recorder.getPersistedMessage?.(),
      "canonical input",
    );
    expect(persisted.content).not.toContain("initial-secret");
    expect(persisted.content).toContain("Check ");
    expect(persisted.content).toContain(" before execution.");
    expect(turn.turn.ctx).toMatchObject({
      Body: persisted.content,
      BodyForAgent: persisted.content,
      BodyForCommands: persisted.content,
      RawBody: persisted.content,
    });
    const history = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", { sessionKey: key });
    expect(history.ok, JSON.stringify(history)).toBe(true);
    expect(JSON.stringify(history.payload?.messages)).not.toContain("initial-secret");
    expect(JSON.stringify(history.payload?.messages)).toContain(JSON.stringify(persisted.content));
  } finally {
    const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
    for (const [turn] of dispatch.start.mock.calls) {
      turn.replyAdmissionTicket?.release();
      turn.admission.cleanupAdmittedRun();
      clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
    }
    await released;
    applyLoggingConfig(previousLogging);
    ws.close();
  }
});

test.for([
  { id: "openclaw-control-ui", mode: "webchat", worktree: true },
  { id: "openclaw-control-ui", mode: "webchat", worktree: false },
  { id: "cli", mode: "cli", worktree: true },
  { id: "cli", mode: "cli", worktree: false },
] as const)(
  "recovers an acknowledged $id first turn (worktree=$worktree) before dispatch",
  async ({ id, mode, worktree }) => {
    testState.agentConfig = { workspace };
    testState.gatewayControlUi = { allowedOrigins: ["http://localhost"] };
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openClient({
      client: { id, mode, platform: "test", version: "1.0.0" },
      browserOrigin: mode === "webchat" ? "http://localhost" : undefined,
    });
    const key = `agent:main:dashboard:durable-${id}-${worktree}`;
    const message = "Reply with exactly: retained first message.";
    dispatch.start.mockClear();
    agentCommandMock.mockImplementation(async (raw) => {
      const options = raw as AgentCommandGatewayIngressOpts;
      expect(options.pinnedWidgetAuthoring).toBe(mode === "webchat" ? true : undefined);
      const entry = expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey: key, storePath }),
        "session at execution",
      );
      expect(entry.pendingWorktree).toBeUndefined();
      if (worktree) {
        expect(entry.worktree?.id).toBeDefined();
        expect(entry.spawnedCwd).not.toBe(workspace);
      }
      await options.userTurnTranscriptRecorder?.persistApproved();
    });
    let captured: StartChatDispatchParams | undefined;
    try {
      const created = await rpcReq<{
        key: string;
        sessionId: string;
        runId: string;
        runStarted: boolean;
      }>(ws, "sessions.create", {
        agentId: "main",
        key,
        cwd: workspace,
        worktree,
        worktreeName: worktree ? `durability-${id}` : undefined,
        message,
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      captured = expectDefined(dispatch.start.mock.calls[0]?.[0], "accepted dispatch");
      const target = { agentId: "main", sessionKey: key, storePath };
      const before = expectDefined(loadSessionEntry(target), "created session");
      expect(before.pendingWorktree !== undefined).toBe(worktree);
      const followup = "Also retain this queued follow-up.";
      if (worktree) {
        const sent = await rpcReq(ws, "chat.send", {
          sessionKey: key,
          message: followup,
          idempotencyKey: `followup-${id}`,
        });
        expect(sent.ok, JSON.stringify(sent)).toBe(true);
        const pending = await rpcReq<{ pendingInputs: { items: unknown[] } }>(ws, "chat.history", {
          sessionKey: key,
        });
        expect(JSON.stringify(pending.payload?.pendingInputs.items)).toContain(followup);
      }
      // Drop process-only dispatches; do not run their terminal/error persistence.
      const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      await released;
      const cfg = getRuntimeConfig();
      await markStartupOrphanedMainSessionsForRecovery({ cfg });
      const recovery = await recoverRestartAbortedMainSessions({
        cfg,
        gatewayRuntime: expectDefined(captured.context.recoveryRuntime, "Gateway recovery owner"),
      });
      expect(
        recovery,
        JSON.stringify({
          entry: loadSessionEntry(target),
          outcomes: [...captured.context.dedupe.values()],
        }),
      ).toMatchObject({
        settled: 1,
        failed: 0,
      });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      const after = expectDefined(loadSessionEntry(target), "recovered session");
      expect(after.pendingWorktree).toBeUndefined();
      expect(after.sessionId).toBe(created.payload?.sessionId);
      const transcript = await loadTranscriptEvents({ ...target, sessionId: after.sessionId });
      expect(transcript.filter((event) => JSON.stringify(event).includes(message))).toHaveLength(1);
      const history = await rpcReq<{
        messages: unknown[];
        pendingInputs: { items: Array<{ state: string; message: unknown }> };
      }>(ws, "chat.history", {
        sessionKey: key,
      });
      expect(history.ok, JSON.stringify(history)).toBe(true);
      expect(JSON.stringify(history.payload?.messages)).toContain(message);
      if (worktree) {
        expect(history.payload?.pendingInputs.items).toMatchObject([{ state: "interrupted" }]);
        expect(JSON.stringify(history.payload?.pendingInputs.items)).toContain(followup);
        expect(JSON.stringify(history.payload?.messages)).not.toContain(followup);
      }
    } finally {
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      ws.close();
      const owned = await managedWorktrees.findLiveByOwner("session", key);
      if (owned) {
        await managedWorktrees.remove({
          id: owned.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
      testState.agentConfig = undefined;
    }
  },
);
