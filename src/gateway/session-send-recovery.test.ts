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
}));
vi.mock(
  "../agents/main-session-recovery/main-session-restart-recovery-shared.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../agents/main-session-recovery/main-session-restart-recovery-shared.js")
    >()),
    discoverRestartRecoveryStoreTargets: io.discover,
  }),
);
vi.mock("../config/sessions/session-entry-read-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../config/sessions/session-entry-read-maintenance.js")
  >()),
  readPendingInputRecoveryEntriesInWorker: io.entries,
}));
vi.mock("../config/sessions/session-pending-input-history.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-pending-input-history.js")>()),
  listSessionPendingInputs: io.pending,
}));
vi.mock("../config/sessions/session-pending-input-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-pending-input-source.js")>()),
  readPendingInputSource: io.source,
}));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  appendSessionTranscriptReport: io.report,
}));
vi.mock("../config/sessions/transcript-write-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/transcript-write-context.js")>()),
  withSessionTranscriptWriteAssertion: (_scope: unknown, guard: () => void, run: () => unknown) => {
    guard();
    return run();
  },
}));
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
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
const targetEntry = { sessionId: "target-id", updatedAt: 1 };
const dispatch = vi.fn();
const warn = vi.fn();
const controller = () => new AbortController();
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  recoveryRuntime: createMockGatewayRecoveryRuntime({ dispatchAgent: dispatch }),
});
context.logGateway.warn = warn;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  setRuntimeConfigSnapshot(config);
  sourceEntry = {
    sessionId: "source-id",
    updatedAt: 1,
    lifecycleRevision: "source-before-reset",
  };
  io.discover.mockResolvedValue([{ agentId: "main", storePath: "/fixture/sessions.json" }]);
  io.entries.mockResolvedValue([{ sessionKey: delivery.target.sessionKey, entry: targetEntry }]);
  io.pending.mockResolvedValue({ items: [input], total: 1 });
  io.source.mockResolvedValue({
    snapshot: {
      current: true,
      pending: {
        input_id: input.id,
        state: "interrupted",
        consumed_event_id: null,
        message_json: JSON.stringify(input.message),
      },
    },
    assertCurrent() {},
  });
  io.load.mockImplementation(async ({ key }: { key: string }) => ({
    agentId: "main",
    canonicalKey: key,
    storePath: "/fixture/sessions.json",
    store: { [key]: key === delivery.source.sessionKey ? sourceEntry : targetEntry },
  }));
  io.report.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
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
  io.source.mockImplementation(async (_scope: unknown, key: string) => ({
    snapshot: {
      current: true,
      pending: {
        input_id: key === input.message.idempotencyKey ? input.id : next.id,
        state: "interrupted",
        consumed_event_id: null,
        message_json: JSON.stringify(
          key === input.message.idempotencyKey ? input.message : next.message,
        ),
      },
    },
    assertCurrent() {},
  }));
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
  const recovery = recoverSessionSendDeliveries(context, controller().signal);
  await Promise.all([recovery, vi.runAllTimersAsync()]);
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
    const recovery = recoverSessionSendDeliveries(context, cancellation.signal);
    await Promise.all([recovery, vi.runAllTimersAsync()]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(io.report).toHaveBeenCalledTimes(change === "consumed" || change === "abort" ? 0 : 1);
    if (
      change === "reset" ||
      change === "replaced" ||
      change === "archive" ||
      change === "permission"
    ) {
      const notice = io.report.mock.calls[0]![1].selectReport(undefined);
      expect(notice.content).toContain(
        change === "permission"
          ? "current session permissions do not allow automatic delivery"
          : "the source or destination session was reset, archived, or replaced",
      );
      expect(notice.content).not.toContain("Reader capacity exhausted");
    }
  },
);

const privateDatabasePath = "/synthetic/private/agents/main/openclaw-agent.sqlite";
const quarantineCommand = `mv ${privateDatabasePath} /synthetic/private/quarantine/`;
const privateDiagnostic = `Inspection failed at ${privateDatabasePath}; ${quarantineCommand}`;

it.each([
  {
    name: "capacity",
    error: new WorkerTaskError(privateDiagnostic, "overloaded"),
    reason: "transient-admission",
    attempts: 3,
    description: "the Gateway was still unavailable after 3 automatic attempts",
  },
  {
    name: "pending inspection",
    error: new AgentDatabaseAdmissionError({
      agentId: "main",
      paths: [privateDatabasePath],
      code: "agent-database-inspection-pending",
      reason: privateDiagnostic,
      repairHint: quarantineCommand,
    }),
    reason: "transient-admission",
    attempts: 3,
    description: "the Gateway was still unavailable after 3 automatic attempts",
  },
  {
    name: "failed inspection",
    error: new AgentDatabaseAdmissionError({
      agentId: "main",
      paths: [privateDatabasePath],
      code: "agent-database-inspection-failed",
      reason: privateDiagnostic,
      repairHint: quarantineCommand,
    }),
    reason: "store-unavailable",
    attempts: 1,
    description: "session storage was unavailable",
  },
  {
    name: "unknown",
    error: new Error(privateDiagnostic),
    reason: "unknown",
    attempts: 1,
    description: "delivery failed",
  },
])(
  "keeps path-bearing $name diagnostics out of saved recovery notices",
  async ({ error, reason, attempts, description }) => {
    io.load.mockRejectedValue(error);
    const recovery = recoverSessionSendDeliveries(context, controller().signal);
    await Promise.all([recovery, vi.runAllTimersAsync()]);
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
  const recovery = recoverSessionSendDeliveries(context, controller().signal);
  await Promise.all([recovery, vi.runAllTimersAsync()]);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(io.report).not.toHaveBeenCalled();
});

it.each([
  new SessionStoreUnavailableError("main", "schema-missing"),
  new SessionStoreUnavailableError("main", "read-failed", {
    name: "SqliteError",
    code: "SQLITE_BUSY",
    message: "Reader is locked",
  }),
  new AgentDatabaseAdmissionError({
    agentId: "main",
    paths: [],
    code: "agent-database-inspection-pending",
    reason: "Inspection is starting",
    repairHint: "Wait for inspection",
  }),
])("retries storage readiness without replacing the saved delivery: %s", async (error) => {
  io.load.mockRejectedValueOnce(error);
  const recovery = recoverSessionSendDeliveries(context, controller().signal);
  await Promise.all([recovery, vi.runAllTimersAsync()]);
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
  const recovery = recoverSessionSendDeliveries(context, controller().signal);
  await Promise.all([recovery, vi.runAllTimersAsync()]);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(io.report.mock.calls[0]![1].selectReport(undefined).details.inputs[0]).toMatchObject({
    attempts: 1,
  });
});
