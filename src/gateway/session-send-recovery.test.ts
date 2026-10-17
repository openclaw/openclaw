import { performance } from "node:perf_hooks";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { AgentDatabaseAdmissionError } from "../state/agent-database-admission.js";
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
}));
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
    __openclaw: { sessionSendDelivery: delivery },
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
const dispatch = vi.fn();
const warn = vi.fn();
const controller = () => new AbortController();
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  recoveryRuntime: createMockGatewayRecoveryRuntime({ dispatchAgent: dispatch }),
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
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
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
      __openclaw: { sessionSendDelivery: { ...delivery, runId: "next-delivery" } },
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
  ["capacity", new WorkerTaskError(privateDiagnostic, "overloaded"), exhausted],
  ["pending inspection", inspectionError("pending"), exhausted],
  [
    "failed inspection",
    inspectionError("failed"),
    {
      reason: "store-unavailable",
      attempts: 1,
      description: "session storage was unavailable",
    },
  ],
  [
    "unknown",
    new Error(privateDiagnostic),
    {
      reason: "unknown",
      attempts: 1,
      description: "delivery failed",
    },
  ],
] as const)(
  "keeps path-bearing %s diagnostics out of saved recovery notices",
  async (_name, error, { reason, attempts, description }) => {
    io.load.mockRejectedValue(error);
    await recoverWithTimers();
    expect(dispatch).not.toHaveBeenCalled();
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
    expect(logs).toContain(privateDatabasePath);
    expect(logs).toContain(quarantineCommand);
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
