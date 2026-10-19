import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  abortAndDrainEmbeddedAgentRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing as embeddedRunTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { startGatewayDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { createReplyOperation, type ReplyOperation } from "../../sessions/session-controller.js";
import {
  assertSessionControllerOperation,
  isReplyRunEvidenceStale,
} from "../../sessions/session-controller.state.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { QuestionManager } from "../question-manager.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const ref = {
  sessionId: "human-wait-session",
  sessionKey: "agent:main:main",
  runId: "human-wait-run",
};
let manager: QuestionManager;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let authority: AgentRunDelegatedAuthority;
let unregister: () => void;
let client: GatewayClient;
let handlers: ReturnType<typeof createQuestionHandlers>;
let admission: PreparedAgentRunAdmission;
let onBroadcast: (event: string) => void;
let requesterActive: boolean;
let validateAuthority: ReturnType<typeof createAgentRuntimeApprovalAuthorityValidator>;
const abort = vi.fn();
let handle: EmbeddedAgentQueueHandle;
let operation: ReplyOperation;

beforeEach(async () => {
  handle = {
    runId: ref.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
  setDiagnosticsEnabledForProcess(true);
  scheduler = createTestGatewayScheduler("fake-timers");
  manager = new QuestionManager(scheduler);
  onBroadcast = () => {};
  requesterActive = true;
  const validateRunAuthority = createAgentRuntimeApprovalAuthorityValidator();
  validateAuthority = (identity) => requesterActive && validateRunAuthority(identity);
  registerAgentRunContext(ref.runId, { sessionKey: ref.sessionKey, agentId: "main" });
  admission = prepareSystemAgentRunAdmission({}, ref.runId, "main", "question-recovery-test");
  const admitted = await admission.admit("embedded");
  authority = getAdmittedRunDelegatedAuthority(admitted)!;
  operation = createReplyOperation({ ...ref, resetTriggered: false });
  unregister = registerAgentRunDelegatedAuthorityClosedHandler(() =>
    manager.cancelClosedAuthorities(),
  );
  client = {
    connect: { scopes: ["operator.admin"] },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: ref.sessionKey,
        operationalRunInstance: authority.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      },
    },
  } as GatewayClient;
  handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    scheduler,
  );
  abort.mockReset().mockImplementation(() => {
    releaseAgentRunDelegatedAuthority(authority);
    clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
    operation.complete();
  });
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "main",
    sessionKey: ref.sessionKey,
  });
  if (!caller) {
    throw new Error("question recovery fixture requires an admitted Gateway caller");
  }
  const watchdogAttempt = operation.watchdog.attachAttempt({
    assertCurrent: () => assertSessionControllerOperation(operation),
  });
  await withGatewayToolCallerIdentity(
    {
      ...caller,
      watchdogAttempt,
      embeddedRunToolAuthorityBinding: (registration) => ({
        source: "reply",
        acceptsRequesterOrigin: () => false,
        operation,
        watchdogAttempt,
        project: () => undefined,
        projectAsync: async () => undefined,
        assertRegistrationActive: () => assertSessionControllerOperation(operation),
        assertActive: () => {
          assertSessionControllerOperation(operation);
          if (registration.handle !== handle) {
            throw new Error("question recovery fixture handle changed");
          }
        },
      }),
    },
    () =>
      setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey, undefined, undefined, operation),
  );
});

afterEach(async () => {
  manager.close();
  await manager.drain();
  resetDiagnosticStateForTest();
  admission.close();
  releaseAgentRunDelegatedAuthority(authority);
  unregister();
  clearAgentRunContext(ref.runId);
  operation.complete();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

async function call(
  method: string,
  params: Record<string, unknown>,
  trusted = true,
  requestAuthority: Pick<GatewayRequestHandlerOptions, "signal" | "hasCurrentClientAuthority"> = {},
) {
  const responses: Parameters<RespondFn>[] = [];
  const cfg = {};
  await handlers[method]!({
    req: { type: "req", id: "request", method, params },
    params,
    client: trusted ? client : ({ connect: { scopes: ["operator.admin"] } } as GatewayClient),
    respond: (...args) => responses.push(args),
    isWebchatConnect: () => false,
    ...requestAuthority,
    context: {
      broadcast: (event: string) => onBroadcast(event),
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: validateAuthority,
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  return responses[0];
}

async function request(trusted = true, timeoutMs = 3_600_000, id = "human-question") {
  const params = {
    id,
    agentId: "main",
    sessionKey: ref.sessionKey,
    runId: ref.runId,
    timeoutMs,
    questions: [
      {
        questionId: "answer",
        header: "Input",
        question: "Provide the requested input",
        options: [],
        isOther: true,
      },
    ],
  };
  expect((await call("question.request", params, trusted))?.[0]).toBe(true);
  expect(manager.get(params.id)).toMatchObject({
    status: "pending",
    expiresAtMs: Date.now() + timeoutMs,
  });
  return params.id;
}

function startQuestionTool(toolCallId: string) {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    ...ref,
    toolName: "ask_user",
    toolCallId,
  });
}

it("keeps an accepted one-hour question alive through default diagnostic recovery", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const recovery = vi.fn(recoverStuckDiagnosticSession);
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      {},
      { recoverStuckSession: recovery },
    );
    startQuestionTool("human-call");
    await vi.advanceTimersByTimeAsync(10_000);
    const id = await request();
    await vi.advanceTimersByTimeAsync(920_000);
    expect(recovery).toHaveBeenCalledWith(
      expect.objectContaining({ allowActiveAbort: true, queueDepth: 0 }),
    );
    expect(abort).not.toHaveBeenCalled();
    expect(manager.get(id)?.status).toBe("pending");
    const answer = manager.waitAnswer(id);
    await vi.advanceTimersByTimeAsync(2_500_000);
    expect(abort).not.toHaveBeenCalled();
    expect(
      (
        await call("question.resolve", {
          id,
          answers: { answers: { answer: ["synthetic-human-answer"] } },
        })
      )?.[0],
    ).toBe(true);
    await expect(answer).resolves.toMatchObject({
      status: "answered",
      answers: {
        answers: { answer: ["synthetic-human-answer"] },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abort).not.toHaveBeenCalled();
    // Resolution is real progress, but a tool that stays hung is still recovered.
    await vi.advanceTimersByTimeAsync(900_000);
    // Diagnostic callbacks may only observe recovery already started by the owner timer.
    await operation.ownerSettlement;
    await Promise.all(recovery.mock.results.map((result) => result.value));
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

function recover() {
  vi.setSystemTime(Date.now() + 930_000);
  return recoverStuckDiagnosticSession({
    ...ref,
    operation,
    ageMs: 930_000,
    queueDepth: 0,
    allowActiveAbort: true,
  });
}

it("keeps a replacement alive when a heartbeat expires its pending question", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const heartbeatAtMs = Date.now() + 900_000;
    const recovery = vi.fn(recoverStuckDiagnosticSession);
    const replacement: EmbeddedAgentQueueHandle = {
      ...handle,
      abort: vi.fn(() => clearActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey)),
    };
    onBroadcast = (event) => {
      if (event === "question.resolved") {
        setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
      }
    };
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      {},
      {
        recoverStuckSession: recovery,
        emitMemorySample: () => {
          if (Date.now() === heartbeatAtMs) {
            // Synchronous sampling crosses expiry before its timer can run;
            // this does not depend on equal-deadline timer ordering.
            vi.setSystemTime(heartbeatAtMs + 100);
          }
          return {
            rssBytes: 100,
            heapTotalBytes: 80,
            heapUsedBytes: 40,
            externalBytes: 10,
            arrayBuffersBytes: 5,
          };
        },
        sampleLiveness: () => null,
      },
    );
    startQuestionTool("heartbeat-expiry-call");
    await vi.advanceTimersByTimeAsync(50);
    const id = await request(true, 900_000);
    const answer = manager.waitAnswer(id);

    await vi.advanceTimersByTimeAsync(899_950);
    await Promise.all(recovery.mock.results.map((result) => result.value));

    await expect(answer).resolves.toEqual({ status: "expired" });
    expect(abort).not.toHaveBeenCalled();
    expect(replacement.abort).not.toHaveBeenCalled();
  });
});

it("keeps resumed question work alive when attention reporting settles the question", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const recovery = vi.fn(recoverStuckDiagnosticSession);
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      {},
      { recoverStuckSession: recovery, sampleLiveness: () => null },
    );
    startQuestionTool("reporting-settlement-call");
    const id = await request();
    const answer = manager.waitAnswer(id);
    const unsubscribe = onDiagnosticEvent((event) => {
      if (
        event.type === "session.stalled" &&
        event.sessionId === ref.sessionId &&
        event.sessionKey === ref.sessionKey &&
        event.ageMs === 900_000
      ) {
        // Attention events can settle a question after the heartbeat captured its generation.
        manager.cancel(id);
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(900_000);
      expect(manager.observe(id)?.record.status).toBe("cancelled");
      const outcomes = await Promise.all(recovery.mock.results.map((result) => result.value));

      await expect(answer).resolves.toEqual({ status: "cancelled" });
      expect(recovery).toHaveBeenCalledWith(
        expect.objectContaining({ allowActiveAbort: true, ageMs: 900_000 }),
      );
      expect(outcomes).toContainEqual(
        expect.objectContaining({ status: "skipped", reason: "active_reply_work" }),
      );
      expect(abort).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

it("does not expire a stopped RPC observer's question before its expiry callback runs", async () => {
  const id = await request(false, 100);
  const events: string[] = [];
  onBroadcast = (event) => events.push(event);
  const observer = new AsyncWorkScope();
  const waiting = observer.track(() => call("question.waitAnswer", { id }, false));
  try {
    observer.beginClose();
    // The clock can pass expiry while its timer is still queued. Observation
    // cleanup must not turn that queued deadline into a question decision.
    vi.setSystemTime(Date.now() + 101);
    await expect(waiting).resolves.toEqual([true, { status: "pending" }, undefined]);
    await observer.drain();
    manager.close();
    expect(events).toEqual([]);
  } finally {
    manager.close();
    await waiting;
    await observer.drain();
  }
});

it.each(["signal", "current client"] as const)(
  "denies a stopped observer's local response when its %s authority closes",
  async (source) => {
    const id = await request(false, 100);
    const events: string[] = [];
    onBroadcast = (event) => events.push(event);
    const observer = new AsyncWorkScope();
    const controller = new AbortController();
    let current = true;
    const registered = vi.spyOn(manager, "waitAnswer");
    const waiting = observer.track(() =>
      call("question.waitAnswer", { id }, false, {
        signal: controller.signal,
        hasCurrentClientAuthority: () => current,
      }),
    );
    const result = Promise.allSettled([waiting]);
    try {
      expect(registered).toHaveBeenCalledExactlyOnceWith(id, undefined, undefined);
      observer.beginClose();
      if (source === "signal") {
        controller.abort(new Error("Question request source closed"));
      } else {
        current = false;
      }
      vi.setSystemTime(Date.now() + 101);
      expect((await result)[0]).toMatchObject({
        status: "rejected",
        reason: {
          message:
            source === "signal"
              ? "Question request source closed"
              : "Gateway requester authority changed",
        },
      });
      await observer.drain();
      expect(manager.observe(id)?.record.status).toBe("pending");
      expect(events).toEqual([]);
    } finally {
      observer.beginClose();
      await result;
      await observer.drain();
      registered.mockRestore();
    }
  },
);

it("does not let operator questions or public diagnostic text suppress unrelated run recovery", async () => {
  const id = await request(false);
  startQuestionTool(id);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  expect(manager.get(id)?.status).toBe("pending");
});

it("keeps explicit user abort authoritative during human input", async () => {
  const id = await request();
  expect(operation.watchdog.snapshot().waits).toContainEqual(
    expect.objectContaining({ kind: "human_question" }),
  );
  await expect(recover()).resolves.toMatchObject({ reason: "active_reply_work" });
  await expect(
    abortAndDrainEmbeddedAgentRun({ ...ref, reason: "user_abort" }),
  ).resolves.toMatchObject({
    aborted: true,
    drained: true,
  });
  expect(manager.get(id)?.status).toBe("cancelled");
});

it("accepts late human input through reply admission instead of treating its owner as stale", async () => {
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => "human-wait-surface",
    project: () => "human-wait-surface",
  });
  await request();
  startQuestionTool("late-answer-call");
  await vi.advanceTimersByTimeAsync(930_000);
  expect(isReplyRunEvidenceStale(operation)).toBe(false);
  await expect(
    admitReplyTurn({
      sessionKey: ref.sessionKey,
      sessionId: ref.sessionId,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
    }),
  ).resolves.toMatchObject({
    status: "skipped",
    reason: "active-run",
    activeOperation: operation,
  });
});

it("does not protect an unrelated reply backend that copies the waiting run's IDs", async () => {
  const unrelatedOperation = createReplyOperation({
    sessionKey: "agent:main:unrelated",
    sessionId: ref.sessionId,
    resetTriggered: false,
  });
  unrelatedOperation.attachBackend({ ...handle, kind: "embedded", cancel: () => {} });
  unrelatedOperation.setPhase("running");
  await request();
  try {
    startQuestionTool("unrelated-call");
    vi.setSystemTime(Date.now() + 930_000);
    expect(isReplyRunEvidenceStale(unrelatedOperation)).toBe(true);
  } finally {
    unrelatedOperation.complete();
  }
});

it("does not transfer a pending question to a replacement handle with the same run ID", async () => {
  await request();
  const replacement = {
    ...handle,
    abort: vi.fn(() => {
      clearActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey);
      operation.complete();
    }),
  };
  setActiveEmbeddedRun(ref.sessionId, replacement, ref.sessionKey, undefined, undefined, operation);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  expect(replacement.abort).toHaveBeenCalledTimes(1);
  expect(abort).not.toHaveBeenCalled();
});

it("refuses to bind new authority to the old handle when a run ID is reused", async () => {
  await request();
  const replacementAuthority = claimAgentRunDelegatedAuthority({
    runId: ref.runId,
    instanceId: "replacement-instance",
  });
  try {
    client = {
      ...client,
      internal: {
        agentRuntimeIdentity: {
          ...client!.internal!.agentRuntimeIdentity!,
          operationalRunInstance: replacementAuthority.operationalRunInstance,
          delegatedAuthority: { kind: "local", ...replacementAuthority },
        },
      },
    } as GatewayClient;
    await request(true, 3_600_000, "replacement-question");
    await expect(recover()).resolves.toMatchObject({ status: "aborted" });
  } finally {
    releaseAgentRunDelegatedAuthority(replacementAuthority);
  }
});

it.each(["pending", "requester-inactive"] as const)(
  "rechecks a question accepted after recovery was queued (%s)",
  async (terminal) => {
    const { promise: gate, resolve: release } = createDeferred();
    const preRecoveryWait = operation.watchdog.beginWait({
      kind: "runtime_owned",
      isCurrent: () => true,
    });
    const recovery = vi.fn(async (params: Parameters<typeof recoverStuckDiagnosticSession>[0]) => {
      await gate;
      return recoverStuckDiagnosticSession(params);
    });
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      {},
      { recoverStuckSession: recovery },
    );
    startQuestionTool("queued-call");
    await vi.advanceTimersByTimeAsync(360_000);
    expect(recovery).toHaveBeenCalledTimes(1);
    preRecoveryWait.close();
    await request();
    expect(operation.watchdog.snapshot().waits).toContainEqual(
      expect.objectContaining({ kind: "human_question" }),
    );
    if (terminal === "requester-inactive") {
      // Worker placement or turn capability can close while the local run claim survives.
      requesterActive = false;
      manager.cancelClosedAuthorities();
    }
    release();
    const outcome = await recovery.mock.results[0]!.value;
    if (terminal === "requester-inactive") {
      expect(outcome).toMatchObject({ status: "aborted" });
      expect(abort).toHaveBeenCalledOnce();
      return;
    }
    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "active_reply_work",
    });
    expect(abort).not.toHaveBeenCalled();
  },
);

it("keeps the run protected until its last pending human question settles", async () => {
  const first = await request();
  const second = await request(true, 3_600_000, "second-question");
  manager.cancel(first);
  expect(operation.watchdog.snapshot().waits).toContainEqual(
    expect.objectContaining({ kind: "human_question" }),
  );
  await expect(recover()).resolves.toMatchObject({ reason: "active_reply_work" });
  manager.cancel(second);
  await expect(recover()).resolves.toMatchObject({ status: "aborted" });
});

it("does not abort a replacement installed synchronously by question expiry", async () => {
  const id = await request(true, 900_000);
  const expiringOperation = operation;
  const replacement = { ...handle, abort: vi.fn() };
  const installReplacement = () => {
    if (operation === expiringOperation) {
      expiringOperation.complete();
      operation = createReplyOperation({ ...ref, resetTriggered: false });
      setActiveEmbeddedRun(
        ref.sessionId,
        replacement,
        ref.sessionKey,
        undefined,
        undefined,
        operation,
      );
    }
  };
  onBroadcast = (event) => {
    if (event === "question.resolved") {
      installReplacement();
    }
  };
  const installOnExpiry = expiringOperation.watchdog.beginWait({
    kind: "runtime_owned",
    isCurrent: () => {
      const expired = manager.observe(id)?.record.status === "expired";
      if (expired) {
        installReplacement();
      }
      return !expired;
    },
  });
  vi.setSystemTime(Date.now() + 900_000);
  try {
    await expect(
      recoverStuckDiagnosticSession({
        ...ref,
        operation: expiringOperation,
        ageMs: 930_000,
        queueDepth: 0,
        allowActiveAbort: true,
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "stale_session_state",
    });
    expect(operation).not.toBe(expiringOperation);
  } finally {
    installOnExpiry.close();
    await manager.drain();
  }
  expect(abort).not.toHaveBeenCalled();
  expect(replacement.abort).not.toHaveBeenCalled();
});
