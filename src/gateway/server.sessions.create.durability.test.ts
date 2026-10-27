import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  recoverRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import * as sessionInputActors from "../config/sessions/session-input-actor.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { recordSessionParticipantInWorker } from "../config/sessions/session-sharing-store.async.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { readLoggingConfig } from "../logging/config.js";
import { applyLoggingConfig } from "../logging/logger.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import {
  getRpcSource,
  requestRpcSourceCancellation,
} from "../sessions/session-controller.rpc-sources.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { runOutsideStoreWriterContext } from "../shared/store-writer-queue.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import type { StartChatDispatchParams } from "./server-methods/chat-send-agent-dispatch.types.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  createGitWorkspace,
  removeOwnedSessionWorktree,
} from "./server.sessions.create.projects.test-support.js";
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
                  const committing =
                    (command.type === "session.actor.acceptInput" ||
                      command.type === "session.actor.adoptRun") &&
                    typeof command.input === "object" &&
                    command.input !== null &&
                    "turn" in command.input &&
                    command.input.turn !== undefined;
                  if (!committing) {
                    return worker.execute(command, commandOptions);
                  }
                  turnBoundary.committing = true;
                  try {
                    turnBoundary.afterPrepare?.();
                    const result = await worker.execute(command, commandOptions);
                    turnBoundary.afterCommit?.();
                    return result;
                  } finally {
                    turnBoundary.committing = false;
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

beforeEach(() => {
  dispatch.start.mockClear();
});

afterEach(() => {
  turnBoundary.committing = false;
  turnBoundary.afterPrepare = undefined;
  turnBoundary.afterCommit = undefined;
  vi.restoreAllMocks();
});

function releaseDispatches() {
  for (const [turn] of dispatch.start.mock.calls) {
    turn.admission.cleanupAdmittedRun();
    clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
  }
}

async function drainDispatches(storePath: string, identities: string[]) {
  const released = captureSessionControllerSettlement({ scope: storePath, identities });
  releaseDispatches();
  await released;
}

async function matchingTranscript(scope: Parameters<typeof loadTranscriptEvents>[0], text: string) {
  return (await loadTranscriptEvents(scope)).filter((event) =>
    JSON.stringify(event).includes(text),
  );
}

async function accepted<T extends Record<string, unknown>>(
  request: ReturnType<typeof rpcReq<T>>,
  payload: Partial<T> = {},
) {
  const reply = await request;
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, payload });
  return expectDefined(reply.payload, "successful RPC payload");
}

function captureInitial(key: string, beforeSend?: () => void) {
  let initial: GatewayRequestHandlerOptions | undefined;
  const settled = createDeferred();
  const send = chatSendOwner.handleDirectExternalChatSend;
  const intercept = vi
    .spyOn(chatSendOwner, "handleDirectExternalChatSend")
    .mockImplementation(async (options) => {
      if (options.params.sessionKey === key) {
        initial = options;
        beforeSend?.();
      }
      try {
        await send(options);
      } finally {
        if (options.params.sessionKey === key) {
          settled.resolve();
        }
      }
    });
  return {
    get options() {
      return expectDefined(initial, "initial request");
    },
    get runId() {
      return String(this.options.params.idempotencyKey);
    },
    settled: settled.promise,
    restore: () => intercept.mockRestore(),
  };
}

async function inputFixture(key: string, options?: Parameters<typeof openClient>[0]) {
  const { storePath } = await createSessionStoreDir();
  const connection = await openClient(options);
  const target = { agentId: "main", sessionKey: key, storePath };
  const send = (message: string, idempotencyKey: string) =>
    rpcReq<{ status: string }>(connection.ws, "chat.send", {
      sessionKey: key,
      message,
      idempotencyKey,
    });
  return Object.assign(connection, {
    storePath,
    key,
    target,
    create: (params: Record<string, unknown> = {}, runStarted?: boolean) =>
      accepted(
        rpcReq<{ sessionId: string; runStarted: boolean }>(connection.ws, "sessions.create", {
          agentId: "main",
          key,
          ...params,
        }),
        runStarted === undefined ? {} : { runStarted },
      ),
    send,
    retry: (message: string, runId: string, status = "started") =>
      accepted(send(message, runId), { status }),
    history: () =>
      rpcReq<{
        messages: unknown[];
        pendingInputs: { items: Array<{ state: string; message: unknown }> };
      }>(connection.ws, "chat.history", { sessionKey: key }),
    read: () => expectDefined(loadSessionEntry(target), "persisted session"),
    expectReceipt: (runId: string, sessionId?: string) =>
      expect(loadSessionEntry(target)).toMatchObject({
        ...(sessionId === undefined ? {} : { sessionId }),
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
      }),
    settlement: () => captureSessionControllerSettlement({ scope: storePath, identities: [key] }),
    drain: () => drainDispatches(storePath, [key]),
  });
}

async function expectUncommittedInput(
  target: { agentId: string; sessionKey: string; storePath: string },
  entry: NonNullable<ReturnType<typeof loadSessionEntry>>,
) {
  expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
  expect(entry.restartRecoveryDeliverySourceRunId).toBeUndefined();
  const scope = { ...target, sessionId: entry.sessionId };
  expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
  expect(await loadTranscriptEvents(scope)).toEqual([
    expect.objectContaining({ type: "session", id: entry.sessionId }),
  ]);
  return scope;
}

test("persists and dispatches concurrent Gateway inputs while participant writes queue", async () => {
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const { storePath } = await createSessionStoreDir();
  const { ws } = await openClient();
  const inputs = Array.from({ length: 2 }, (_, index) => ({
    agentId: "main",
    key: `agent:main:dashboard:concurrent-initial-${index}`,
    message: `Persist concurrent Gateway initial input ${index}.`,
  }));
  const competingWrites: Promise<unknown>[] = [];
  const intervenedInputs = new Set<string>();
  const acquire = sessionInputActors.acquireSessionInputActor;
  vi.spyOn(sessionInputActors, "acquireSessionInputActor").mockImplementation(async (...args) => {
    const input = await acquire(...args);
    if (input) {
      const accept = input.actor.acceptInput;
      vi.spyOn(input.actor, "acceptInput").mockImplementationOnce(async (...command) => {
        const recordParticipant = (promptedAt: number) =>
          recordSessionParticipantInWorker(
            { agentId: "main", storePath, sessionKey: input.actor.target.sessionKey },
            {
              identity: {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: "gateway-client",
              },
              promptedAt,
              sessionAgentId: "main",
            },
          );
        await recordParticipant(1);
        intervenedInputs.add(input.actor.target.sessionKey);
        const pending = accept(...command);
        // This independent writer must wait behind the complete input admission.
        competingWrites.push(runOutsideStoreWriterContext(() => recordParticipant(2)));
        return pending;
      });
    }
    return input;
  });
  try {
    const created = await Promise.all(
      inputs.map((params) =>
        rpcReq<{ sessionId: string; runStarted: boolean }>(ws, "sessions.create", params),
      ),
    );
    for (const [index, response] of created.entries()) {
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(response.payload?.runStarted, JSON.stringify(response)).toBe(true);
      const input = inputs[index]!;
      const scope = {
        agentId: input.agentId,
        sessionKey: input.key,
        sessionId: expectDefined(response.payload?.sessionId, "created session ID"),
        storePath,
      };
      expect(await matchingTranscript(scope, input.message)).toHaveLength(1);
    }
    expect(intervenedInputs).toEqual(new Set(inputs.map((input) => input.key)));
    expect(dispatch.start).toHaveBeenCalledTimes(inputs.length);
  } finally {
    await Promise.all(competingWrites);
    await drainDispatches(
      storePath,
      inputs.map((input) => input.key),
    );
    ws.close();
  }
});

test.for([
  "before-input",
  "after-preparation",
  "transaction-refused",
  "commit-refused",
  "revoked-after-preparation",
  "permission-revoked-at-commit",
  "idle-commit-refused",
] as const)("keeps only the created session when input fails at %s", async (fault, { signal }) => {
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const fixture = await inputFixture(`agent:main:dashboard:initial-failure-${fault}`);
  const { key, target } = fixture;
  let { ws } = fixture;
  const message = "Only retain this initial input after its restart claim commits.";
  const failure = new Error(`initial input ${fault}`);
  const hit = vi.fn();
  const initial = captureInitial(key, () => {
    if (fault === "before-input") {
      hit();
      throw failure;
    }
  });
  const refuse = probe.admission(workerAdmission, (request, grant, callback) => {
    if (
      fault === "permission-revoked-at-commit" &&
      turnBoundary.committing &&
      request.stage === "commit"
    ) {
      hit();
      const options = initial.options;
      invalidateGatewayDeviceRevocation(
        options.context,
        expectDefined(options.client?.connect.device?.id, "authenticated device"),
        "operator",
      );
    }
    if (
      turnBoundary.committing &&
      ((fault === "transaction-refused" && request.stage === "transaction") ||
        ((fault === "commit-refused" || fault === "idle-commit-refused") &&
          request.stage === "commit"))
    ) {
      hit();
      throw failure;
    }
    callback(request, grant);
  });
  if (fault === "after-preparation" || fault === "revoked-after-preparation") {
    turnBoundary.afterPrepare = () => {
      turnBoundary.afterPrepare = undefined;
      hit();
      if (fault === "after-preparation") {
        throw failure;
      }
      const run = expectDefined(getRpcSource(initial.runId), "admitted run");
      run.adapter.abortStopReason = "restart";
      requestRpcSourceCancellation(run, failure);
    };
  }
  try {
    const params = { agentId: "main", key, message };
    let created: Awaited<ReturnType<typeof fixture.create>> | undefined;
    if (fault === "permission-revoked-at-commit") {
      // Revocation suppresses this request's wire response. Join its real handler
      // and native settlement instead of waiting for an intentionally absent ACK.
      const responses: unknown[] = [];
      const requestId = "revoked-create";
      const onMessage = (raw: unknown) => responses.push(JSON.parse(String(raw)));
      ws.on("message", onMessage);
      try {
        ws.send(JSON.stringify({ type: "req", id: requestId, method: "sessions.create", params }));
        await withinTest(initial.settled, signal);
        await fixture.settlement();
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
      fixture.ws = ws = (await openClient()).ws;
    } else if (fault === "idle-commit-refused") {
      created = await fixture.create();
      expect((await fixture.send(message, fault)).ok).toBe(false);
      await fixture.settlement();
    } else {
      created = await fixture.create({ message }, false);
    }
    expect(hit).toHaveBeenCalledOnce();
    expect(dispatch.start).not.toHaveBeenCalled();
    const before = fixture.read();
    if (created) {
      expect(before.sessionId).toBe(created.sessionId);
    }
    const scope = await expectUncommittedInput(target, before);
    const described = await rpcReq<{ sessionId: string }>(ws, "sessions.describe", {
      key,
      agentId: "main",
    });
    expect(described.ok, JSON.stringify(described)).toBe(true);

    // Same source identity remains retryable: no ACK transferred custody before the failure.
    refuse.mockRestore();
    initial.restore();
    const runId = fault === "idle-commit-refused" ? fault : initial.runId;
    await fixture.retry(message, runId);
    fixture.expectReceipt(runId, before.sessionId);
    expect(await matchingTranscript(scope, message)).toHaveLength(1);
    if (fault === "idle-commit-refused") {
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      expect(await matchingTranscript(scope, message)).toMatchObject([
        { message: { role: "user", content: message, idempotencyKey: `${runId}:user` } },
      ]);
    }
    expect(dispatch.start).toHaveBeenCalledOnce();
  } finally {
    turnBoundary.afterPrepare = undefined;
    refuse.mockRestore();
    initial.restore();
    await fixture.drain();
    ws.close();
  }
});

test.for(["lost-worker-response", "restart-before-ack"] as const)(
  "retains exactly one recoverable initial turn after %s",
  async (fault) => {
    dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
    const fixture = await inputFixture(`agent:main:dashboard:initial-committed-${fault}`);
    const { ws, key, target } = fixture;
    const message = "Recover this committed initial input exactly once.";
    const initial = captureInitial(key);
    const hit = vi.fn();
    const stop = onSessionTranscriptUpdate((update) => {
      if (
        fault !== "restart-before-ack" ||
        update.target.sessionKey !== key ||
        hit.mock.calls.length
      ) {
        return;
      }
      const runId = initial.runId;
      const entry = loadSessionEntry(target);
      if (entry?.restartRecoveryDeliveryRunId !== runId) {
        return;
      }
      hit();
      const run = expectDefined(getRpcSource(runId), "committed run");
      run.adapter.abortStopReason = "restart";
      requestRpcSourceCancellation(run);
    });
    if (fault === "lost-worker-response") {
      turnBoundary.afterCommit = () => {
        turnBoundary.afterCommit = undefined;
        hit();
        throw new Error("Native turn committed but its command response was lost");
      };
    }
    agentCommandMock.mockImplementation(async (raw) => {
      const options = raw as AgentCommandGatewayIngressOpts;
      await options.userTurnTranscriptRecorder?.persistApproved();
    });
    try {
      const created = await fixture.create({ message }, fault === "lost-worker-response");
      expect(hit).toHaveBeenCalledOnce();
      const options = initial.options;
      const runId = initial.runId;
      const before = fixture.read();
      fixture.expectReceipt(runId, created.sessionId);
      const scope = { ...target, sessionId: before.sessionId };
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      await fixture.drain();
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
        await fixture.retry(message, runId);
        expect(dispatch.start).toHaveBeenCalledOnce();
        const retriedRelease = fixture.settlement();
        const [turn] = dispatch.start.mock.calls[0]!;
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(runId, turn.admission.lifecycleGeneration);
        await retriedRelease;
        await markStartupOrphanedMainSessionsForRecovery({ cfg });
      }
      const recovered = await recover();
      expect(recovered).toMatchObject({ settled: 1, failed: 0 });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(await matchingTranscript(scope, message)).toHaveLength(1);
      await fixture.retry(message, runId, "ok");
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(await matchingTranscript(scope, message)).toHaveLength(1);
    } finally {
      turnBoundary.afterCommit = undefined;
      stop();
      initial.restore();
      releaseDispatches();
      ws.close();
    }
  },
);

test("dispatches the original bytes of a committed initial input", async () => {
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const fixture = await inputFixture("agent:main:dashboard:initial-redaction");
  const { ws } = fixture;
  const message = "Check initial-secret before execution.";
  const previousLogging = readLoggingConfig();
  applyLoggingConfig({ redactPatterns: ["initial-secret"] });
  try {
    await fixture.create({ message }, true);
    const turn = expectDefined(dispatch.start.mock.calls[0]?.[0], "admitted initial dispatch");
    const persisted = expectDefined(
      turn.userTurn.recorder.getPersistedMessage?.(),
      "canonical input",
    );
    expect(persisted.content).toBe(message);
    expect(turn.turn.ctx).toMatchObject({
      Body: persisted.content,
      BodyForAgent: persisted.content,
      BodyForCommands: persisted.content,
      RawBody: persisted.content,
    });
    const history = await fixture.history();
    expect(history.ok, JSON.stringify(history)).toBe(true);
    expect(JSON.stringify(history.payload?.messages)).toContain("initial-secret");
    expect(JSON.stringify(history.payload?.messages)).toContain(JSON.stringify(persisted.content));
  } finally {
    await fixture.drain();
    applyLoggingConfig(previousLogging);
    ws.close();
  }
});

test.for([
  { id: "openclaw-control-ui", mode: "webchat", worktree: true },
  { id: "cli", mode: "cli", worktree: false },
] as const)(
  "recovers an acknowledged $id first turn (worktree=$worktree) before dispatch",
  async ({ id, mode, worktree }) => {
    testState.agentConfig = { workspace };
    testState.gatewayControlUi = { allowedOrigins: ["http://localhost"] };
    const key = `agent:main:dashboard:durable-${id}-${worktree}`;
    const fixture = await inputFixture(key, {
      client: { id, mode, platform: "test", version: "1.0.0" },
      browserOrigin: mode === "webchat" ? "http://localhost" : undefined,
    });
    const { ws, target } = fixture;
    const message = "Reply with exactly: retained first message.";
    agentCommandMock.mockImplementation(async (raw) => {
      const options = raw as AgentCommandGatewayIngressOpts;
      expect(options.pinnedWidgetAuthoring).toBe(mode === "webchat" ? true : undefined);
      const entry = fixture.read();
      expect(entry.pendingWorktree).toBeUndefined();
      if (worktree) {
        expect(entry.worktree?.id).toBeDefined();
        expect(entry.spawnedCwd).not.toBe(workspace);
      }
      await options.userTurnTranscriptRecorder?.persistApproved();
    });
    try {
      const created = await fixture.create(
        {
          cwd: workspace,
          worktree,
          worktreeName: worktree ? `durability-${id}` : undefined,
          message,
        },
        true,
      );
      const captured = expectDefined(dispatch.start.mock.calls[0]?.[0], "accepted dispatch");
      const before = fixture.read();
      expect(before.pendingWorktree !== undefined).toBe(worktree);
      const followup = "Also retain this queued follow-up.";
      if (worktree) {
        const sent = await fixture.send(followup, `followup-${id}`);
        expect(sent.ok, JSON.stringify(sent)).toBe(true);
        const pending = await fixture.history();
        expect(JSON.stringify(pending.payload?.pendingInputs.items)).toContain(followup);
      }
      // Drop process-only dispatches; do not run their terminal/error persistence.
      await fixture.drain();
      const cfg = getRuntimeConfig();
      await markStartupOrphanedMainSessionsForRecovery({ cfg });
      const recovery = await recoverRestartAbortedMainSessions({
        cfg,
        gatewayRuntime: expectDefined(captured.context.recoveryRuntime, "Gateway recovery owner"),
      });
      expect(recovery).toMatchObject({ settled: 1, failed: 0 });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      const after = fixture.read();
      expect(after.pendingWorktree).toBeUndefined();
      expect(after.sessionId).toBe(created.sessionId);
      expect(
        await matchingTranscript({ ...target, sessionId: after.sessionId }, message),
      ).toHaveLength(1);
      const history = await fixture.history();
      expect(history.ok, JSON.stringify(history)).toBe(true);
      expect(JSON.stringify(history.payload?.messages)).toContain(message);
      if (worktree) {
        expect(history.payload?.pendingInputs.items).toMatchObject([{ state: "interrupted" }]);
        expect(JSON.stringify(history.payload?.pendingInputs.items)).toContain(followup);
        expect(JSON.stringify(history.payload?.messages)).not.toContain(followup);
      }
    } finally {
      releaseDispatches();
      ws.close();
      await removeOwnedSessionWorktree(key);
      testState.agentConfig = undefined;
    }
  },
);
