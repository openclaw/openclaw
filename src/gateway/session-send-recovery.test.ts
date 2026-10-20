import { performance } from "node:perf_hooks";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabasePreparationContext } from "../state/agent-database-preparation-context.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { createGatewayStartupTrace } from "./server-startup-trace.js";
import type { SessionSendDelivery } from "./session-send-delivery.js";
import { readSessionSendDeliveryAdmission } from "./session-send-delivery.js";
import { recoverSessionSendDeliveries } from "./session-send-recovery.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";

const io = vi.hoisted(() => ({
  discover: vi.fn(),
  entries: vi.fn(),
  pending: vi.fn(),
  source: vi.fn(),
  load: vi.fn(),
  report: vi.fn(),
  withdraw: vi.fn(),
  restoreOperator:
    vi.fn<typeof import("./operator-run-recovery.js").restoreGatewayQueuedOperatorRecovery>(),
  resumeMain:
    vi.fn<
      typeof import("../agents/main-session-recovery/main-session-restart-recovery.js").retryRestartAbortedMainSessionRecovery
    >(),
}));
vi.mock(
  import("../agents/main-session-recovery/main-session-restart-recovery.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    retryRestartAbortedMainSessionRecovery: io.resumeMain,
  }),
);
vi.mock(
  import("../agents/main-session-recovery/main-session-restart-recovery-shared.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    discoverRestartRecoveryStoreTargets: io.discover,
  }),
);
vi.mock(import("../config/sessions/session-entry-read-maintenance.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPendingInputRecoveryEntriesInWorker: io.entries,
}));
vi.mock(import("../config/sessions/session-pending-input-history.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readSessionSendRecoveryPage: io.pending,
}));
vi.mock(import("../config/sessions/session-pending-input-source.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPendingInputSource: io.source,
}));
vi.mock(import("../config/sessions/session-accessor.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  appendSessionTranscriptReport: io.report,
}));
vi.mock(
  import("../config/sessions/session-pending-input-withdrawal.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    discardSessionPendingInput: io.withdraw,
  }),
);
vi.mock(import("./operator-run-recovery.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  restoreGatewayQueuedOperatorRecovery: io.restoreOperator,
}));
vi.mock(import("./session-utils-store-worker.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewaySessionStoreTargetInWorker: io.load,
}));

const delivery: SessionSendDelivery = {
  version: 1,
  runId: "saved-delivery",
  source: {
    agentId: "main",
    sessionKey: "agent:main:source",
    sessionId: "source-id",
    lifecycleRevision: "source-before-reset",
  },
  target: { agentId: "main", sessionKey: "agent:main:target", sessionId: "target-id" },
  sandboxed: false,
  message: "Saved peer update",
};
const input: SessionPendingInput = {
  id: "saved-input",
  runId: delivery.runId,
  acceptedAt: 1,
  state: "interrupted",
  message: {
    role: "user",
    content: delivery.message,
    timestamp: 1,
    idempotencyKey: `${delivery.runId}:user`,
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: delivery.source.sessionKey,
    },
    __openclaw: { sessionSendDelivery: { ...delivery, operatorSource: null } },
  },
};
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { sessions: { visibility: "all" } },
  session: { communication: { send: "always", receive: "always" } },
};
let sourceEntry: {
  sessionId: string;
  updatedAt: number;
  lifecycleRevision: string;
  archivedAt?: number;
  communication?: { send: "never" };
};
let targetEntry: {
  sessionId: string;
  updatedAt: number;
  archivedAt?: number;
  lifecycleRevision?: string;
};
let currentConfig = config;
const dispatch = vi.fn();
const resumeChat = vi.fn();
const warn = vi.fn();
const controller = () => new AbortController();
const context = createDirectChatContext({
  getRuntimeConfig: () => currentConfig,
  recoveryRuntime: createMockGatewayRecoveryRuntime({
    dispatchAgent: dispatch,
    resumeChatInput: resumeChat,
  }),
});
context.logGateway.warn = warn;
const sourceSnapshot = (
  pending = input,
  state = "interrupted",
  consumed_event_id: string | null = null,
) => ({
  snapshot: {
    current: true,
    pending: {
      input_id: pending.id,
      run_id: pending.runId,
      request_hash: "request:original-request-fingerprint",
      state,
      consumed_event_id,
      message_json: JSON.stringify(pending.message),
    },
  },
  assertCurrent() {},
});
const storeTarget = (key: string) => ({
  agentId: "main",
  canonicalKey: key,
  storePath: "/fixture/sessions.json",
  store: { [key]: key === delivery.source.sessionKey ? sourceEntry : targetEntry },
});
const recover = (signal = controller().signal) => recoverSessionSendDeliveries(context, signal);
async function recoverWithTimers(signal = controller().signal) {
  await Promise.all([recover(signal), vi.runAllTimersAsync()]);
}
function expectNoCalls(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
function timed<T>(ms: number, value: () => T) {
  return async () => {
    vi.advanceTimersByTime(ms);
    return value();
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  currentConfig = config;
  setRuntimeConfigSnapshot(config);
  sourceEntry = {
    sessionId: "source-id",
    updatedAt: 1,
    lifecycleRevision: "source-before-reset",
  };
  targetEntry = { sessionId: "target-id", updatedAt: 1 };
  io.discover.mockResolvedValue([{ agentId: "main", storePath: "/fixture/sessions.json" }]);
  io.entries.mockResolvedValue([{ sessionKey: delivery.target.sessionKey, entry: targetEntry }]);
  io.pending.mockResolvedValue({ items: [input], total: 1 });
  io.source.mockResolvedValue(sourceSnapshot());
  io.load.mockImplementation(async ({ key }: { key: string }) => storeTarget(key));
  io.report.mockResolvedValue({ ok: true });
  io.withdraw.mockResolvedValue(true);
  io.resumeMain.mockResolvedValue({ started: 1, settled: 0, failed: 0, skipped: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  recordAgentDatabaseAdmissions([]);
});

it("retains queued peers when the interrupted predecessor is paused", async () => {
  io.entries.mockResolvedValue([
    {
      sessionKey: delivery.target.sessionKey,
      entry: { ...targetEntry, abortedLastRun: true },
    },
  ]);
  io.resumeMain.mockResolvedValue({ started: 0, settled: 0, failed: 0, skipped: 0 });

  await recover();

  expect(io.resumeMain).toHaveBeenCalledOnce();
  expectNoCalls(dispatch, resumeChat, io.withdraw, io.report);
});

it("recovers a logical agent's saved input from its shared physical store", async () => {
  const sharedDelivery = {
    ...delivery,
    operatorSource: null,
    target: { ...delivery.target, agentId: "secondary", sessionKey: "agent:secondary:target" },
  };
  const sharedInput = {
    ...input,
    message: { ...input.message, __openclaw: { sessionSendDelivery: sharedDelivery } },
  };
  io.entries.mockResolvedValue([
    { sessionKey: sharedDelivery.target.sessionKey, entry: targetEntry },
  ]);
  io.pending.mockResolvedValue({ items: [sharedInput], total: 1 });
  io.source.mockResolvedValue(sourceSnapshot(sharedInput));
  io.load.mockImplementation(async ({ key }: { key: string }) => ({
    ...storeTarget(key),
    agentId: key === sharedDelivery.target.sessionKey ? "secondary" : "main",
  }));
  await recover();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0]![0]).toMatchObject({
    agentId: "secondary",
    idempotencyKey: delivery.runId,
  });
  expect(io.source.mock.calls[0]![0]).toMatchObject({
    agentId: "secondary",
    storePath: "/fixture/sessions.json",
  });
  expectNoCalls(io.report, io.withdraw, warn);
});

it.each(["admitted", "reconfigured", "permission-revoked", "failed", "cancelled"] as const)(
  "recovers a skipped store after its admission owner settles: %s",
  async (outcome) => {
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: ["/fixture/sessions.json"],
      reason: "Synthetic startup inspection",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal]);
    io.discover.mockImplementation(async () =>
      readAgentDatabaseAdmissionRefusal("main")
        ? []
        : [{ agentId: "main", storePath: "/fixture/sessions.json" }],
    );
    const joined = createDeferred();
    const prepared = createDeferred();
    const cancellation = controller();
    const recovery = withAgentDatabasePreparationContext(
      () => ({
        waitForAgentPreparation: () => {
          joined.resolve();
          return prepared.promise;
        },
      }),
      () => recover(cancellation.signal),
    );
    try {
      await awaitGateBeforeSettlement(
        joined.promise,
        recovery,
        "saved-input recovery finished without joining pending store admission",
      );
      expectNoCalls(dispatch, io.report);
      if (outcome === "failed") {
        failPendingAgentDatabase(refusal, new Error("Synthetic inspection failure"), {});
      } else {
        await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {});
      }
      if (outcome === "reconfigured" || outcome === "permission-revoked") {
        currentConfig =
          outcome === "reconfigured"
            ? { ...config }
            : {
                ...config,
                session: { communication: { send: "never", receive: "always" } },
              };
        setRuntimeConfigSnapshot(currentConfig);
      }
      if (outcome === "cancelled") {
        cancellation.abort();
      }
      prepared.resolve();
      if (outcome === "cancelled") {
        await expect(recovery).rejects.toThrow();
      } else {
        await recovery;
      }
      if (outcome === "admitted" || outcome === "reconfigured") {
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]![0].idempotencyKey).toBe(delivery.runId);
        expect(io.discover.mock.calls[1]![0].agentIds).toEqual(new Set(["main"]));
        expect(io.discover.mock.calls[1]![0].cfg).toBe(currentConfig);
      } else {
        expectNoCalls(dispatch);
        if (outcome === "permission-revoked") {
          expect(io.report).toHaveBeenCalledOnce();
          expect(
            io.report.mock.calls[0]![1].selectReport(undefined).details.inputs[0],
          ).toMatchObject({
            reason: "permission-denied",
            attempts: 1,
          });
        } else {
          expect(io.discover).toHaveBeenCalledOnce();
        }
      }
      if (outcome !== "permission-revoked") {
        expectNoCalls(io.report);
      }
    } finally {
      prepared.resolve();
      await recovery.catch(() => {});
    }
  },
);

it.each([
  ["chat", "transient"],
  ["chat", "policy"],
  ["peer", "transient"],
  ["peer", "policy"],
] as const)(
  "keeps a %s input's %s failure scoped to its session and eligibility",
  async (inputKind, failure) => {
    const inputs = ["first", "next", "other"].map((id): SessionPendingInput => ({
      id,
      runId: id,
      acceptedAt: Date.now(),
      state: "interrupted",
      message: {
        role: "user",
        content: id,
        timestamp: Date.now(),
        idempotencyKey: `${id}:user`,
        __openclaw: { chatInputRecovery: { version: 1 } },
      },
    }));
    if (inputKind === "peer") {
      inputs[0] = {
        ...input,
        id: "first",
        runId: "first",
        message: {
          ...input.message,
          idempotencyKey: "first:user",
          __openclaw: {
            sessionSendDelivery: { ...delivery, runId: "first", operatorSource: null },
          },
        },
      };
    }
    io.entries.mockResolvedValue([
      { sessionKey: delivery.target.sessionKey, entry: targetEntry },
      { sessionKey: "agent:main:other", entry: { ...targetEntry, sessionId: "other-id" } },
    ]);
    io.pending.mockImplementation(async ({ sessionKey }) => ({
      items: sessionKey === delivery.target.sessionKey ? inputs.slice(0, 2) : inputs.slice(2),
    }));
    io.source.mockImplementation(async (_scope, key) => {
      const pending = inputs.find((entry) => entry.message.idempotencyKey === key);
      return pending ? sourceSnapshot(pending) : undefined;
    });
    const attempts: string[] = [];
    const attempt = (runId: string) => {
      attempts.push(runId);
      if (runId === "first") {
        throw failure === "transient"
          ? new WorkerTaskError("Reader capacity exhausted", "overloaded")
          : new Error("Operator access revoked");
      }
    };
    resumeChat.mockImplementation(async ({ runId }) => attempt(runId));
    dispatch.mockImplementation(async ({ idempotencyKey }) => attempt(idempotencyKey));
    await recoverWithTimers();
    expect(attempts).toEqual(
      failure === "transient" ? ["first", "first", "first", "other"] : ["first", "next", "other"],
    );
    expectNoCalls(io.withdraw);
    if (inputKind === "chat") {
      expectNoCalls(dispatch, io.report);
    } else {
      expect(io.report).toHaveBeenCalledOnce();
    }
  },
);

it("resumes chat inputs in acceptance order across pages, excluding expired and withdrawn inputs", async () => {
  const chat = (id: string, ageMs = 0, state: SessionPendingInput["state"] = "interrupted") => ({
    ...input,
    id,
    runId: id,
    acceptedAt: Date.now() - ageMs,
    state,
    message: {
      ...input.message,
      idempotencyKey: `${id}:user`,
      __openclaw: { chatInputRecovery: { version: 1 } },
    },
  });
  io.source.mockImplementation(async (_scope, idempotencyKey: string) => {
    const id = idempotencyKey.slice(0, -":user".length);
    return sourceSnapshot(
      chat(id),
      id === "withdrawn" ? "cancelled" : "interrupted",
      id === "consumed" ? "collected-event" : null,
    );
  });
  io.pending
    .mockResolvedValueOnce({ items: [chat("second")], nextBefore: 1 })
    .mockResolvedValueOnce({
      items: [
        chat("expired", 24 * 60 * 60_000 + 1),
        chat("cancelled", 0, "cancelled"),
        chat("live", 0, "queued"),
        chat("withdrawn"),
        chat("consumed"),
        chat("first"),
      ],
    });
  let releaseFirst!: () => void;
  let enterFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  resumeChat.mockImplementationOnce(async () => {
    enterFirst();
    await firstHeld;
  });
  const recovering = recover();
  await firstEntered;
  expect(resumeChat.mock.calls.map(([target]) => target.runId)).toEqual(["first"]);
  releaseFirst();
  await recovering;
  expect(resumeChat.mock.calls.map(([target]) => target.runId)).toEqual(["first", "second"]);
  expectNoCalls(dispatch, io.report, io.withdraw);
});

it.each(["replaced", "archived-source", "archived-target"] as const)(
  "settles %s inputs durably so the second restart is silent",
  async (change) => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    const { openOpenClawAgentDatabase } = await import("../state/openclaw-agent-db.js");
    const { writeSessionEntry } =
      await import("../config/sessions/session-accessor.sqlite-entry-store.js");
    const { stageSessionPendingInput } =
      await import("../config/sessions/session-accessor.pending-inputs.js");
    const history = await vi.importActual<
      typeof import("../config/sessions/session-pending-input-history.js")
    >("../config/sessions/session-pending-input-history.js");
    const source = await vi.importActual<
      typeof import("../config/sessions/session-pending-input-source.js")
    >("../config/sessions/session-pending-input-source.js");
    const reports =
      await import("../config/sessions/session-accessor.sqlite-transcript-reports.js");
    const withdrawal = await vi.importActual<
      typeof import("../config/sessions/session-pending-input-withdrawal.js")
    >("../config/sessions/session-pending-input-withdrawal.js");
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = { ...delivery.target, storePath: database.path };
      writeSessionEntry(database, scope.sessionKey, targetEntry);
      const receipt = await stageSessionPendingInput(scope, {
        runId: delivery.runId,
        message: input.message,
        assertCurrent() {},
      });
      expect(receipt).toBeDefined();
      receipt!.finish("interrupted");
      await receipt!.settled?.();
      if (change === "replaced") {
        sourceEntry.lifecycleRevision = "source-after-reset";
      } else if (change === "archived-source") {
        sourceEntry.archivedAt = 2;
      } else {
        targetEntry.archivedAt = 2;
        writeSessionEntry(database, scope.sessionKey, targetEntry);
      }
      io.discover.mockResolvedValue([{ agentId: "main", storePath: database.path }]);
      io.pending.mockImplementation(history.readSessionSendRecoveryPage);
      io.source.mockImplementation(source.readPendingInputSource);
      io.report.mockImplementation(reports.appendSessionTranscriptReport);
      io.withdraw.mockImplementation(withdrawal.discardSessionPendingInput);

      await recover();
      expect(dispatch).not.toHaveBeenCalled();
      const notice = await reports.readLatestSessionTranscriptReport(scope, [
        "session-send-recovery-blocked",
      ]);
      if (change === "replaced") {
        expect(notice).toMatchObject({
          ok: true,
          value: { content: expect.stringContaining("session was reset or replaced") },
        });
      } else {
        expect(notice).toEqual({ ok: true, value: undefined });
        expectNoCalls(warn, io.report);
      }
      expect(await history.listSessionPendingInputs(scope)).toMatchObject({
        items: [{ state: "cancelled", message: { display: false } }],
      });

      warn.mockClear();
      io.report.mockClear();
      await recover();
      expectNoCalls(warn, io.report, dispatch);
      expect(
        await reports.readLatestSessionTranscriptReport(scope, ["session-send-recovery-blocked"]),
      ).toEqual(notice);
    });
  },
);

it("partitions delivery recovery work and retry backoff in the startup summary", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "0");
  const startedAt = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - startedAt);
  const info = vi.spyOn(context.logGateway, "info").mockImplementation(() => {});
  const trace = createGatewayStartupTrace(context.logGateway, 0);
  io.discover.mockImplementation(
    timed(10, () => [{ agentId: "main", storePath: "/fixture/sessions.json" }]),
  );
  io.entries.mockImplementation(
    timed(20, () => [{ sessionKey: delivery.target.sessionKey, entry: targetEntry }]),
  );
  io.pending.mockImplementation(timed(30, () => ({ items: [input], total: 1 })));
  io.source.mockImplementationOnce(
    timed(40, () => {
      throw new WorkerTaskError("Reader starting", "unavailable");
    }),
  );
  io.load.mockImplementation(async ({ key }: { key: string }) => {
    vi.advanceTimersByTime(50);
    return storeTarget(key);
  });
  sourceEntry.sessionId = "replaced-source";
  io.report.mockImplementation(timed(250, () => ({ ok: true })));
  try {
    const recovery = trace.measure("sidecars.subagent-recovery", () =>
      trace.measure("sidecars.delivery-recovery", () =>
        recoverSessionSendDeliveries(context, controller().signal, trace),
      ),
    );
    await Promise.all([recovery, vi.runAllTimersAsync()]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(info.mock.calls.at(-1)?.[0]).toContain(
      "deliveryMs=5450.0 deliveryDiscoveryMs=10.0 deliveryEntriesMs=20.0 deliveryHistoryMs=30.0 deliveryReplayMs=140.0 deliveryNoticesMs=250.0 retryWaitMs=5000.0",
    );
  } finally {
    trace.close();
  }
});

it("retries transient admission with the saved input and delivery identity, in order", async () => {
  const next = {
    ...input,
    id: "next-input",
    runId: "next-delivery",
    message: {
      ...input.message,
      idempotencyKey: "next-delivery:user",
      __openclaw: {
        sessionSendDelivery: { ...delivery, runId: "next-delivery", operatorSource: null },
      },
    },
  };
  io.pending.mockResolvedValue({ items: [input, next], total: 2 });
  io.source.mockImplementation(async (_scope: unknown, key: string) =>
    sourceSnapshot(key === input.message.idempotencyKey ? input : next),
  );
  const accepted: string[] = [];
  const startedAt = Date.now();
  const attemptTimes: number[] = [];
  dispatch.mockImplementation(async (request) => {
    attemptTimes.push(Date.now() - startedAt);
    expect(request.sessionKey).toBe(delivery.target.sessionKey);
    expect(
      readSessionSendDeliveryAdmission({
        runId: request.idempotencyKey,
        agentId: "main",
        sessionKey: delivery.target.sessionKey,
        sessionId: "target-id",
      })?.acceptedMessage,
    ).toEqual(request.idempotencyKey === delivery.runId ? input.message : next.message);
    if (dispatch.mock.calls.length === 1) {
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Admission is busy",
        retryable: true,
      });
    }
    accepted.push(request.idempotencyKey);
  });
  await recoverWithTimers();
  expect(dispatch.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
    "saved-delivery",
    "saved-delivery",
    "next-delivery",
  ]);
  expect(accepted).toEqual(["saved-delivery", "next-delivery"]);
  expect(attemptTimes).toEqual([0, 5_000, 5_000]);
  expect(io.report).not.toHaveBeenCalled();
});

it.each(["interrupted", "cancelled"] as const)(
  "preserves returned-result semantics while respecting %s custody",
  async (state) => {
    const returnedDelivery: SessionSendDelivery = {
      ...delivery,
      returnedResult: { extraSystemPrompt: "Consume this result once; do not send it back." },
    };
    const returnedInput = {
      ...input,
      message: {
        ...input.message,
        __openclaw: { sessionSendDelivery: { ...returnedDelivery, operatorSource: null } },
      },
    };
    io.pending.mockResolvedValue({ items: [returnedInput], total: 1 });
    sourceEntry.communication = { send: "never" };
    io.source.mockResolvedValue(sourceSnapshot(returnedInput, state));
    dispatch.mockImplementation(async (_request, _timeout, options) => {
      options.assertAdmissionCurrent();
      expect(
        readSessionSendDeliveryAdmission({
          runId: delivery.runId,
          agentId: "main",
          sessionKey: delivery.target.sessionKey,
          sessionId: "target-id",
        })?.acceptedMessage,
      ).toEqual(returnedInput.message);
    });
    await recover();
    expect(dispatch).toHaveBeenCalledTimes(state === "interrupted" ? 1 : 0);
    if (state === "interrupted") {
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: delivery.runId,
        message: delivery.message,
        extraSystemPrompt: "Consume this result once; do not send it back.",
        expectedExistingSessionId: "target-id",
        inputProvenance: input.message.provenance,
      });
      expect(dispatch.mock.calls[0]?.[2].replyExpectation).toBe("optional");
    }
    expectNoCalls(io.report, io.withdraw, warn);
  },
);

it.each(["reset", "replaced", "archive", "permission", "consumed", "abort"] as const)(
  "rechecks %s before a delayed attempt",
  async (change) => {
    const cancellation = controller();
    dispatch.mockImplementationOnce(async () => {
      if (change === "reset") {
        sourceEntry = { ...sourceEntry, lifecycleRevision: "source-after-reset" };
      }
      if (change === "replaced") {
        sourceEntry = { ...sourceEntry, sessionId: "replacement" };
      }
      if (change === "archive") {
        sourceEntry = { ...sourceEntry, archivedAt: 2 };
      }
      if (change === "permission") {
        sourceEntry = { ...sourceEntry, communication: { send: "never" } };
      }
      if (change === "consumed") {
        io.source.mockResolvedValue(undefined);
      }
      if (change === "abort") {
        cancellation.abort();
      }
      throw new WorkerTaskError("Reader capacity exhausted", "overloaded");
    });
    await recoverWithTimers(cancellation.signal);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(io.report).toHaveBeenCalledTimes(
      change === "consumed" || change === "abort" || change === "archive" ? 0 : 1,
    );
    expect(io.withdraw).toHaveBeenCalledTimes(
      change === "reset" || change === "replaced" || change === "archive" ? 1 : 0,
    );
    if (change === "reset" || change === "replaced" || change === "permission") {
      const notice = io.report.mock.calls[0]![1].selectReport(undefined);
      expect(notice.content).toContain(
        change === "permission"
          ? "current session permissions do not allow automatic delivery"
          : "the source or destination session was reset or replaced",
      );
      expect(notice.content).not.toContain("Reader capacity exhausted");
    }
  },
);

it("logs replacement identity and age without session keys or message content", async () => {
  sourceEntry = { ...sourceEntry, lifecycleRevision: "source-after-reset" };
  vi.setSystemTime(10_001);
  await recover();
  const warning = warn.mock.calls[0]![0] as string;
  expect(warning).toContain('"inputId":"saved-input"');
  expect(warning).toContain('"ageMs":10000');
  expect(warning).toContain('"endpoint":"source"');
  expect(warning).toContain('"previousGeneration":"source-before-reset"');
  expect(warning).toContain('"currentGeneration":"source-after-reset"');
  expect(warning).toMatch(/"sessionKeyHash":"[a-f0-9]{16}"/u);
  expect(warning).not.toContain(delivery.source.sessionKey);
  expect(warning).not.toContain(delivery.target.sessionKey);
  expect(warning).not.toContain(delivery.message);
});

it("retains replaced-endpoint inputs when the durable notice is refused", async () => {
  sourceEntry = { ...sourceEntry, sessionId: "replacement" };
  io.report.mockResolvedValue({ ok: false });
  await recover();
  expectNoCalls(dispatch, io.withdraw);
  expect(warn).toHaveBeenCalledWith(
    "Could not record blocked agent-update delivery notice; inputs retained.",
  );
});

const privateDatabasePath = "/synthetic/private/agents/main/openclaw-agent.sqlite";
const quarantineCommand = `mv ${privateDatabasePath} /synthetic/private/quarantine/`;
const privateDiagnostic = `Inspection failed at ${privateDatabasePath}; ${quarantineCommand}`;
const inspectionError = (code: "pending" | "failed", privatePaths = true) =>
  new AgentDatabaseAdmissionError({
    agentId: "main",
    paths: privatePaths ? [privateDatabasePath] : [],
    code: `agent-database-inspection-${code}`,
    reason: privatePaths ? privateDiagnostic : "Inspection is starting",
    repairHint: privatePaths ? quarantineCommand : "Wait for inspection",
  });
const exhausted = {
  reason: "transient-admission",
  attempts: 3,
  description: "the Gateway was still unavailable after 3 automatic attempts",
};

it.each([
  ["capacity", "endpoint", new WorkerTaskError(privateDiagnostic, "overloaded"), exhausted],
  ["pending inspection", "endpoint", inspectionError("pending"), exhausted],
  [
    "failed inspection",
    "endpoint",
    inspectionError("failed"),
    {
      reason: "store-unavailable",
      attempts: 1,
      description: "session storage was unavailable",
    },
  ],
  [
    "unknown",
    "endpoint",
    new Error(privateDiagnostic),
    {
      reason: "unknown",
      attempts: 1,
      description: "delivery failed",
    },
  ],
  [
    "requester preparation capacity",
    "requester",
    new WorkerTaskError(privateDiagnostic, "overloaded"),
    exhausted,
  ],
  [
    "requester authority refusal",
    "requester",
    new Error(privateDiagnostic),
    {
      reason: "requester-unavailable",
      attempts: 1,
      description: "original requester authority is unavailable; submit a new request",
    },
  ],
] as const)(
  "keeps path-bearing %s diagnostics out of saved recovery notices",
  async (_name, stage, error, { reason, attempts, description }) => {
    if (stage === "requester") {
      const acceptedInput: SessionPendingInput = {
        ...input,
        message: {
          ...input.message,
          __openclaw: {
            sessionSendDelivery: {
              ...delivery,
              operatorSource: {
                kind: "channel",
                snapshot: {
                  reference: { version: 1, id: "d0ba40e9-13e6-4e6b-918f-62e8bc12ffbd" },
                  profileId: "original-requester",
                  scopes: ["operator.write"],
                },
              },
            },
          },
        },
      };
      io.pending.mockResolvedValue({ items: [acceptedInput], total: 1 });
      io.source.mockResolvedValue(sourceSnapshot(acceptedInput));
      io.restoreOperator.mockRejectedValue(error);
    } else {
      io.load.mockRejectedValue(error);
    }
    const retries = Array.from({ length: attempts - 1 }, () => createDeferredCore());
    for (const retry of retries) {
      warn.mockImplementationOnce(() => retry.resolve());
    }
    const recovery = recoverSessionSendDeliveries(context, controller().signal);
    for (const retry of retries) {
      // A dynamic requester import can finish after an empty fake-timer drain.
      await Promise.race([retry.promise, recovery]);
      await vi.runAllTimersAsync();
    }
    await recovery;
    expect(dispatch).not.toHaveBeenCalled();
    expect(io.restoreOperator).toHaveBeenCalledTimes(stage === "requester" ? attempts : 0);
    const report = io.report.mock.calls[0]![1].selectReport(undefined);
    expect(report.details.inputs[0]).toEqual({
      inputId: input.id,
      sourceSessionKey: delivery.source.sessionKey,
      reason,
      attempts,
    });
    expect(report.content).toBe(
      "Agent updates not delivered after restart:\n" +
        `- From ${delivery.source.sessionKey}: ${description}.\n` +
        "The updates remain saved; no sender task was rerun. Resend the update or ask the sender to retry.",
    );
    expect(JSON.stringify(report)).not.toContain(privateDatabasePath);
    expect(JSON.stringify(report)).not.toContain(quarantineCommand);
    const logs = warn.mock.calls.map(([line]) => line).join("\n");
    if (reason !== "requester-unavailable") {
      expect(logs).toContain(privateDatabasePath);
      expect(logs).toContain(quarantineCommand);
    }
  },
);

it("retries discovery without losing the saved delivery", async () => {
  io.discover.mockRejectedValueOnce(new WorkerTaskError("Inventory starting", "unavailable"));
  await recoverWithTimers();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(io.report).not.toHaveBeenCalled();
});

it.each(["removed", "retained"] as const)(
  "ignores an already consumed %s input before checking a replaced endpoint",
  async (consumed) => {
    sourceEntry = { ...sourceEntry, sessionId: "replacement" };
    io.source.mockResolvedValue(
      consumed === "removed" ? undefined : sourceSnapshot(input, "queued", "collected-event"),
    );
    await recover();
    expectNoCalls(dispatch, io.load, io.report, warn);
  },
);

it.each([
  new SessionStoreUnavailableError("main", "schema-missing"),
  new SessionStoreUnavailableError("main", "read-failed", {
    name: "SqliteError",
    code: "SQLITE_BUSY",
    message: "Reader is locked",
  }),
  inspectionError("pending", false),
])("retries storage readiness without replacing the saved delivery: %s", async (error) => {
  io.load.mockRejectedValueOnce(error);
  await recoverWithTimers();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(io.report).not.toHaveBeenCalled();
});

it.each([
  new GatewayClientRequestError({
    code: "UNAVAILABLE",
    message: "Admission denied",
    retryable: false,
  }),
  new SqliteWorkerError("Native outcome is unknown", "outcome-unknown"),
  new SessionStoreUnavailableError("main", "read-failed", {
    name: "SqliteError",
    code: "SQLITE_CORRUPT",
    message: "Database is corrupt",
  }),
  new AgentDatabaseAdmissionError({
    agentId: "main",
    paths: [],
    code: "agent-database-ownership-mismatch",
    embeddedOwnerId: "other",
    reason: "Database owner differs",
    repairHint: "Inspect the database owner",
  }),
])("does not retry terminal admission or storage failures: %s", async (error) => {
  dispatch.mockRejectedValue(error);
  await recoverWithTimers();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(io.report.mock.calls[0]![1].selectReport(undefined).details.inputs[0]).toMatchObject({
    attempts: 1,
  });
});
