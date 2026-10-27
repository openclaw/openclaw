import "./session-send-recovery.delivery.mocks.test-support.js";
import { createHash } from "node:crypto";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  failPendingAgentDatabase,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabasePreparationContext } from "../state/agent-database-preparation-context.js";
import { expectNoCalls } from "../test-utils/mock-call-assertions.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import type { SessionSendDelivery } from "./session-send-delivery.js";
import { readSessionSendDeliveryAdmission } from "./session-send-delivery.js";
import { recoverSessionSendDeliveries } from "./session-send-recovery.js";
import { verifyRecoveryNoticeTurnOrdering } from "./session-send-recovery.notice-order.test-support.js";
import {
  config,
  delivery,
  input,
  inspectionError,
  privateDatabasePath,
  quarantineCommand,
  recoveryDiagnosticCases,
  sourceSnapshot,
  terminalRecoveryFailures,
} from "./session-send-recovery.test-support.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";

const { recoveryDeliveryMocks } =
  await import("./session-send-recovery.delivery.mocks.test-support.js");
const recoveryOverrides = vi.hoisted(() => ({
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
    retryRestartAbortedMainSessionRecovery: recoveryOverrides.resumeMain,
  }),
);
vi.mock(import("./operator-run-recovery.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  restoreGatewayQueuedOperatorRecovery: recoveryOverrides.restoreOperator,
}));

const io = { ...recoveryDeliveryMocks, ...recoveryOverrides };

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
const storeTarget = (key: string) => ({
  agentId: key.split(":")[1]!,
  canonicalKey: key,
  storePath: "/fixture/sessions.json",
  store: { [key]: key === delivery.source.sessionKey ? sourceEntry : targetEntry },
});
const recover = (signal = controller().signal) =>
  recoverSessionSendDeliveries(context, signal).settled;
async function recoverWithTimers(signal = controller().signal) {
  await Promise.all([recover(signal), vi.runAllTimersAsync()]);
}
function peerInput(
  overrides: Partial<SessionSendDelivery> & { operatorSource?: unknown },
  saved: Partial<Pick<SessionPendingInput, "id">> = {},
): SessionPendingInput {
  const restored = { ...delivery, operatorSource: null, ...overrides };
  return {
    ...input,
    ...saved,
    runId: restored.runId,
    message: {
      ...input.message,
      idempotencyKey: `${restored.runId}:user`,
      __openclaw: { sessionSendDelivery: restored },
    },
  };
}
function chatInput(
  id: string,
  ageMs = 0,
  state: SessionPendingInput["state"] = "interrupted",
  message: SessionPendingInput["message"] = input.message,
): SessionPendingInput {
  return {
    ...input,
    id,
    runId: id,
    acceptedAt: Date.now() - ageMs,
    state,
    message: {
      ...message,
      idempotencyKey: `${id}:user`,
      __openclaw: { chatInputRecovery: { version: 1 } },
    },
  };
}
function pendingInputs(...items: SessionPendingInput[]) {
  io.pending.mockResolvedValue({ items, total: items.length });
  io.source.mockImplementation(async (_scope, key: string) => {
    const pending = items.find((item) => item.message.idempotencyKey === key);
    return pending ? sourceSnapshot(pending) : undefined;
  });
}
const blockedReport = () => io.report.mock.calls[0]![1].selectReport(undefined);
const inspectionRefusal = (agentId = "main", path = "/fixture/sessions.json") =>
  createAgentDatabaseInspectionRefusal({
    agentId,
    paths: [path],
    reason: "Synthetic startup inspection",
    pending: true,
  });
const acceptedMessage = (runId: string) =>
  readSessionSendDeliveryAdmission({
    runId,
    agentId: "main",
    sessionKey: delivery.target.sessionKey,
    sessionId: "target-id",
  })?.acceptedMessage;
function prepareStoreRecovery(agents: string[], signal = controller().signal) {
  const refusals = agents.map((id) =>
    inspectionRefusal(
      id,
      agents.length === 1 ? "/fixture/sessions.json" : `/fixture/${id}/sessions.json`,
    ),
  );
  recordAgentDatabaseAdmissions(refusals);
  io.discover.mockImplementation(async () =>
    readAgentDatabaseAdmissionRefusal("main")
      ? []
      : [{ agentId: "main", storePath: "/fixture/sessions.json" }],
  );
  const prepared = agents.map(() => createDeferred());
  const joined = createDeferred();
  let waits = 0;
  const recovery = withAgentDatabasePreparationContext(
    () => ({
      waitForAgentPreparation: (id) => {
        if (++waits === agents.length) {
          joined.resolve();
        }
        return prepared[agents.indexOf(id)]!.promise;
      },
    }),
    () => recover(signal),
  );
  return { refusals, prepared, joined: joined.promise, recovery };
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
  pendingInputs(input);
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
  const target = { ...delivery.target, agentId: "secondary", sessionKey: "agent:secondary:target" };
  const sharedInput = peerInput({ target });
  io.entries.mockResolvedValue([{ sessionKey: target.sessionKey, entry: targetEntry }]);
  pendingInputs(sharedInput);
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

it.each(["permission-revoked", "failed", "cancelled"] as const)(
  "recovers a skipped store after its admission owner settles: %s",
  async (outcome) => {
    const cancellation = controller();
    const {
      refusals: [refusal],
      prepared: [prepared],
      joined,
      recovery,
    } = prepareStoreRecovery(["main"], cancellation.signal);
    try {
      await awaitGateBeforeSettlement(
        joined,
        recovery,
        "saved-input recovery finished without joining pending store admission",
      );
      expectNoCalls(dispatch, io.report);
      if (outcome === "failed") {
        failPendingAgentDatabase(refusal!, new Error("Synthetic inspection failure"), {});
      } else {
        await preparePendingAgentDatabase(refusal!, { assertCurrent() {} }, async () => {});
      }
      if (outcome === "permission-revoked") {
        currentConfig = {
          ...config,
          session: { communication: { send: "never", receive: "always" } },
        };
        setRuntimeConfigSnapshot(currentConfig);
      }
      if (outcome === "cancelled") {
        cancellation.abort();
      }
      prepared!.resolve();
      if (outcome === "cancelled") {
        await expect(recovery).rejects.toThrow();
      } else {
        await recovery;
      }
      expectNoCalls(dispatch);
      if (outcome === "permission-revoked") {
        expect(io.report).toHaveBeenCalledOnce();
        expect(blockedReport().details.inputs[0]).toMatchObject({
          reason: "permission-denied",
          attempts: 1,
        });
      } else {
        expect(io.discover).toHaveBeenCalledOnce();
        expectNoCalls(io.report);
      }
    } finally {
      prepared!.resolve();
      await recovery.catch(() => {});
    }
  },
);

it("joins every pending store and replays admitted work before reporting a preparation failure", async ({
  signal,
}) => {
  const {
    refusals,
    prepared: [failed, prepared],
    joined,
    recovery,
  } = prepareStoreRecovery(["secondary", "main"]);
  const failure = new Error("Synthetic preparation failure");
  const settled = vi.fn();
  const observed = recovery.then(settled, settled);
  const rejected = expect(recovery).rejects.toBe(failure);
  try {
    await withinTest(joined, signal);
    failed!.reject(failure);
    await vi.runAllTimersAsync();
    expect(settled).not.toHaveBeenCalled();
    expectNoCalls(dispatch);
    await preparePendingAgentDatabase(refusals[1]!, { assertCurrent() {} }, async () => {});
    prepared!.resolve();
    await rejected;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![0].idempotencyKey).toBe(delivery.runId);
  } finally {
    failed!.reject(failure);
    prepared!.resolve();
    await observed;
  }
});

it("does not join pending preparation when initial recovery fails", async () => {
  recordAgentDatabaseAdmissions([inspectionRefusal()]);
  const failure = new Error("Synthetic discovery failure");
  io.discover.mockRejectedValueOnce(failure);
  const waitForAgentPreparation = vi.fn(async () => {});
  await expect(
    withAgentDatabasePreparationContext(
      () => ({ waitForAgentPreparation }),
      () => recover(),
    ),
  ).rejects.toBe(failure);
  expectNoCalls(waitForAgentPreparation, dispatch);
});

it.each([
  ["chat", "transient"],
  ["chat", "policy"],
  ["peer", "transient"],
  ["peer", "policy"],
] as const)(
  "keeps a %s input's %s failure scoped to its session and eligibility",
  async (inputKind, failure) => {
    const inputs = ["first", "next", "other"].map((id) =>
      chatInput(id, 0, "interrupted", { role: "user", content: id, timestamp: Date.now() }),
    );
    if (inputKind === "peer") {
      inputs[0] = peerInput({ runId: "first" }, { id: "first" });
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
    expect(attempts.filter((runId) => runId !== "other")).toEqual(
      failure === "transient" ? ["first", "first", "first"] : ["first", "next"],
    );
    expect(attempts.filter((runId) => runId === "other")).toEqual(["other"]);
    expectNoCalls(io.withdraw);
    if (inputKind === "chat") {
      expectNoCalls(dispatch, io.report);
    } else {
      expect(io.report).toHaveBeenCalledOnce();
    }
  },
);

it("resumes chat inputs in acceptance order across pages, excluding expired and withdrawn inputs", async () => {
  io.source.mockImplementation(async (_scope, idempotencyKey: string) => {
    const id = idempotencyKey.slice(0, -":user".length);
    return sourceSnapshot(
      chatInput(id),
      id === "withdrawn" ? "cancelled" : "interrupted",
      id === "consumed" ? "collected-event" : null,
    );
  });
  io.pending
    .mockResolvedValueOnce({ items: [chatInput("second")], nextBefore: 1 })
    .mockResolvedValueOnce({
      items: [
        chatInput("expired", 24 * 60 * 60_000 + 1),
        chatInput("cancelled", 0, "cancelled"),
        chatInput("withdrawn"),
        chatInput("consumed"),
        chatInput("first"),
      ],
    });
  const firstEntered = createDeferredCore();
  const firstHeld = createDeferredCore();
  resumeChat.mockImplementationOnce(async () => {
    firstEntered.resolve();
    await firstHeld.promise;
  });
  const recovering = recover();
  await firstEntered.promise;
  expect(resumeChat.mock.calls.map(([target]) => target.runId)).toEqual(["first"]);
  firstHeld.resolve();
  await recovering;
  expect(resumeChat.mock.calls.map(([target]) => target.runId)).toEqual(["first", "second"]);
  expectNoCalls(dispatch, io.report, io.withdraw);
});

it("does not close an accepted chat turn with a blocked-delivery notice", ({ signal }) =>
  verifyRecoveryNoticeTurnOrdering({ io, sourceEntry, resumeChat, warn, recover }, signal));

it("settles archived-target inputs durably so the second restart is silent", async () => {
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
  const reports = await import("../config/sessions/session-accessor.sqlite-transcript-reports.js");
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
    targetEntry.archivedAt = 2;
    writeSessionEntry(database, scope.sessionKey, targetEntry);
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
    expect(notice).toEqual({ ok: true, value: undefined });
    expectNoCalls(warn, io.report);
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
});

it("retries transient admission with the saved input and delivery identity, in order", async () => {
  const next = peerInput({ runId: "next-delivery" }, { id: "next-input" });
  pendingInputs(input, next);
  const accepted: string[] = [];
  const startedAt = Date.now();
  const attemptTimes: number[] = [];
  dispatch.mockImplementation(async (request) => {
    attemptTimes.push(Date.now() - startedAt);
    expect(request.sessionKey).toBe(delivery.target.sessionKey);
    expect(acceptedMessage(request.idempotencyKey)).toEqual(
      request.idempotencyKey === delivery.runId ? input.message : next.message,
    );
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

it("preserves returned-result semantics for an interrupted input", async () => {
  const returnedInput = peerInput({
    returnedResult: { extraSystemPrompt: "Consume this result once; do not send it back." },
  });
  pendingInputs(returnedInput);
  sourceEntry.communication = { send: "never" };
  dispatch.mockImplementation(async (_request, _timeout, options) => {
    options.assertAdmissionCurrent();
    expect(acceptedMessage(delivery.runId)).toEqual(returnedInput.message);
  });
  await recover();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
    idempotencyKey: delivery.runId,
    message: delivery.message,
    extraSystemPrompt: "Consume this result once; do not send it back.",
    expectedExistingSessionId: "target-id",
    inputProvenance: input.message.provenance,
  });
  expect(dispatch.mock.calls[0]?.[2].replyExpectation).toBe("optional");
  expectNoCalls(io.report, io.withdraw, warn);
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
      const notice = blockedReport();
      expect(notice.content).toContain(
        change === "permission"
          ? "current session permissions do not allow automatic delivery"
          : "the source or destination session was reset or replaced",
      );
      expect(notice.content).not.toContain("Reader capacity exhausted");
    }
  },
);

it("redacts session keys and message content from recovery logs", async () => {
  const info = vi.spyOn(context.logGateway, "info");
  sourceEntry = { ...sourceEntry, lifecycleRevision: "source-after-reset" };
  await recover();
  const warning = warn.mock.calls[0]![0] as string;
  expect(warning).not.toContain(delivery.source.sessionKey);
  expect(warning).not.toContain(delivery.target.sessionKey);
  expect(warning).not.toContain(delivery.message);
  const replay = info.mock.calls.find(([line]) => line.startsWith("Pending input replay: "))![0];
  expect(JSON.parse(replay.slice("Pending input replay: ".length))).toMatchObject({
    inputHash: createHash("sha256").update(input.id).digest("hex").slice(0, 16),
    kind: "peer",
    outcome: "blocked",
    waitReason: "endpoint-replaced",
  });
  for (const privateValue of [input.id, delivery.source.sessionKey, delivery.message]) {
    expect(replay).not.toContain(privateValue);
  }
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

it.each(recoveryDiagnosticCases)(
  "keeps path-bearing %s diagnostics out of saved recovery notices",
  async (_name, stage, error, { reason, attempts, description }) => {
    if (stage === "requester") {
      const acceptedInput = peerInput({
        operatorSource: {
          kind: "channel",
          snapshot: {
            reference: { version: 1, id: "d0ba40e9-13e6-4e6b-918f-62e8bc12ffbd" },
            profileId: "original-requester",
            scopes: ["operator.write"],
          },
        },
      });
      pendingInputs(acceptedInput);
      io.restoreOperator.mockRejectedValue(error);
    } else {
      io.load.mockRejectedValue(error);
    }
    const retries = Array.from({ length: attempts - 1 }, () => createDeferredCore());
    for (const retry of retries) {
      warn.mockImplementationOnce(() => retry.resolve());
    }
    const recovery = recoverSessionSendDeliveries(context, controller().signal).settled;
    for (const retry of retries) {
      // A dynamic requester import can finish after an empty fake-timer drain.
      await Promise.race([retry.promise, recovery]);
      await vi.runAllTimersAsync();
    }
    await recovery;
    expect(dispatch).not.toHaveBeenCalled();
    expect(io.restoreOperator).toHaveBeenCalledTimes(stage === "requester" ? attempts : 0);
    const report = blockedReport();
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
  new WorkerTaskError("Inventory starting", "unavailable"),
  new SessionStoreUnavailableError("main", "schema-missing"),
  new SessionStoreUnavailableError("main", "read-failed", {
    name: "SqliteError",
    code: "SQLITE_BUSY",
    message: "Reader is locked",
  }),
  inspectionError("pending", false),
])(
  "retries discovery or storage readiness without replacing the saved delivery: %s",
  async (error) => {
    const stage = error instanceof WorkerTaskError ? io.discover : io.load;
    stage.mockRejectedValueOnce(error);
    await recoverWithTimers();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(io.report).not.toHaveBeenCalled();
  },
);

it.each(terminalRecoveryFailures)(
  "does not retry terminal admission or storage failures: %s",
  async (error) => {
    dispatch.mockRejectedValue(error);
    await recoverWithTimers();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(blockedReport().details.inputs[0]).toMatchObject({
      attempts: 1,
    });
  },
);
