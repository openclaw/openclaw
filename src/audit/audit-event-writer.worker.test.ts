import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import { listAuditEvents, recordAuditEventInDatabase } from "./audit-event-store.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";
import { input, messageEvent, decisionReceipt } from "./audit-event-writer.test-support.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import {
  pageExecutionDecisionFactsForContextInDatabase,
  recordExecutionDecisionFactInDatabase,
} from "./execution-decision-facts.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "./execution-identity-admission.js";
import { prepareExecutionIdentityContextAtAdmission } from "./execution-identity.test-support.js";
import { recordOutboundMessageProgressInDatabase } from "./message-delivery-progress-store.js";

const pruneFault = useSqliteWorkerFault([
  {
    name: "fail_audit_identity_prune",
    match: /^delete from execution_identity_contexts\b/u,
    sql: `CREATE TEMP TRIGGER fail_audit_identity_prune BEFORE DELETE ON main.execution_identity_contexts
      BEGIN SELECT RAISE(ABORT, 'synthetic identity prune failure'); END;`,
  },
  { match: /^insert into audit_events\b/u, exitOnMatch: 2 },
  { match: /^insert into audit_events\b/u, exitOnMatch: 1 },
]);

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function observeProcessRequests() {
  const count = vi.fn();
  const stop = onInternalDiagnosticEvent(
    (event) => {
      if (
        event.type === "worker.request" &&
        event.phase === "queued" &&
        event.requestClass === "audit.writer.process"
      ) {
        count();
      }
    },
    { include: ["worker.request"] },
  );
  return { count, stop };
}

function messageRecorder(writer: AuditEventWriter) {
  return createAuditEventRecorder({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => ({ logging: { audit: { messages: "all" } } }),
    writer,
  });
}

function writerFixture(
  stateDir = tempDirs.make("openclaw-audit-writer-"),
  onError?: (count: number) => void,
) {
  const errors = vi.fn<(error: string) => void>();
  errors.mockImplementation(() => onError?.(errors.mock.calls.length));
  const writer = createAuditEventWriter({
    scheduler: createTestGatewayScheduler(),
    stateDir,
    onError: errors,
  });
  return { writer, errors, database: { env: { OPENCLAW_STATE_DIR: stateDir } } };
}

function rowCounts(db: OpenClawStateDatabase["db"], tables: string[]) {
  return tables.map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
}

function admissionFacts(runId: string) {
  return {
    runId,
    agentId: "main",
    ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    runtime: { kind: "embedded" },
  } as const;
}

describe("audit writer shared worker", () => {
  it("records a warm run start and finish with one worker request", async () => {
    const { writer, errors, database } = writerFixture();
    const recorder = createAgentEventAuditRecorder({ writer, getConfig: () => ({}) });
    await writer.ready;
    expect(writer.record({ ...input(), sourceId: "warm-seed", runId: "warm-seed" })).toBe(true);
    await nextTurn();
    expect((await listAuditEvents({ database, limit: 10 })).events).toHaveLength(1);
    const requests = observeProcessRequests();
    const event = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "run-pair-session",
      runId: "paired-run",
      lifecycleGeneration: "paired-gateway",
      stream: "lifecycle",
      seq: 1,
      ts: Date.now(),
      data: { phase: "start" },
    };
    try {
      recorder.record(event);
      await nextTurn();
      const duringTurn = (await listAuditEvents({ database, limit: 10 })).events;
      recorder.record({ ...event, seq: 2, data: { phase: "end" } });
      await nextTurn();
      const events = (await listAuditEvents({ database, limit: 10 })).events.filter(
        ({ runId }) => runId === event.runId,
      );
      expect(events.map(({ action }) => action).toSorted()).toEqual([
        "agent.run.finished",
        "agent.run.started",
      ]);
      expect(requests.count, "warm audit worker request count").toHaveBeenCalledTimes(1);
      expect(duringTurn).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await recorder.stop();
      requests.stop();
    }
  });

  it.each(["cold", "existing shared actor", "worker death after committed prefix"] as const)(
    "flushes the %s audit FIFO without host SQLite",
    async (mode) => {
      const stateDir = tempDirs.make("openclaw-audit-writer-");
      const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
      if (mode === "existing shared actor") {
        await listAuditEvents({ database, limit: 1 });
      }
      const { contextId, executionId, runId, ...receipt } = decisionReceipt();
      const token = createExecutionIdentityAdmissionToken(runId, {
        contextId,
        executionId,
        now: receipt.occurredAt,
      });
      const nativeOpens = vi.spyOn(requireNodeSqlite(), "DatabaseSync");
      const calibration = openNodeSqliteDatabase(":memory:");
      calibration.close();
      expect(nativeOpens).toHaveBeenCalledTimes(1);
      nativeOpens.mockClear();
      const counters = observeMainThreadSql({ includeClose: true });
      const requests = observeProcessRequests();
      const { writer, errors } = writerFixture(stateDir);
      const recorder = messageRecorder(writer);
      const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
      try {
        await writer.ready;
        if (mode === "worker death after committed prefix") {
          pruneFault.enable(1);
        }
        expect(
          enqueueExecutionIdentityContextAtAdmission(admissionFacts(runId), {
            enabled: true,
            token,
            runtimeInstanceId: "worker-runtime",
          })?.accepted,
        ).toBe(true);
        expect(writer.recordExecutionDecision({ ...receipt, contextId, executionId, runId })).toBe(
          true,
        );
        expect(
          writer.recordExecutionDecisionWork({
            workVersion: 1,
            token,
            receipt: {
              ...receipt,
              receiptId: "worker-private-decision",
              occurredAt: receipt.occurredAt + 1,
            },
            refs: { target: { namespace: "session", value: "private-session-target" } },
          }),
        ).toBe(true);
        recorder.recordMessage(messageEvent("message.outbound.queued"));
        const start = input();
        expect(
          writer.recordRun(start, {
            ...start,
            sourceId: "paired-finish",
            sourceSequence: 2,
            action: "agent.run.finished",
            status: "succeeded",
          }),
        ).toBe(true);
        recorder.recordMessage({
          ...messageEvent("message.outbound.finished"),
          runId,
          executionIdentityToken: token,
        });
      } finally {
        clearSink();
        try {
          await recorder.stop();
          expect(nativeOpens).not.toHaveBeenCalled();
          counters.expectIdle();
        } finally {
          requests.stop();
          counters.restore();
          nativeOpens.mockRestore();
        }
      }

      const replayed = mode === "worker death after committed prefix";
      const owner = openOpenClawStateDatabase(database).db;
      expect(
        rowCounts(owner, [
          "audit_events",
          "outbound_message_execution_bindings",
          "outbound_message_progress",
          "audit_events WHERE kind = 'message'",
        ]),
      ).toEqual([3, 1, 1, 1]);
      expect(errors).toHaveBeenCalledTimes(replayed ? 1 : 0);
      expect(requests.count).toHaveBeenCalledTimes(replayed ? 2 : 1);
      expect(
        owner
          .prepare(
            "SELECT run_id, action FROM audit_events WHERE kind = 'agent_run' ORDER BY sequence",
          )
          .all(),
      ).toEqual([
        { run_id: "run-1", action: "agent.run.started" },
        { run_id: "run-1", action: "agent.run.finished" },
      ]);
      const decisions = pageExecutionDecisionFactsForContextInDatabase(owner, {
        context: token,
        limit: 10,
        now: receipt.occurredAt + 1,
      }).receipts;
      expect(decisions).toHaveLength(2);
      expect(decisions).toContainEqual({ ...receipt, contextId, executionId, runId });
      expect(
        decisions.find((item) => item.receiptId === "worker-private-decision")?.action.targetRef,
      ).toMatch(/^hmac-sha256:v1:/u);

      expect(owner.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    },
  );

  it("drops a repeatedly crashing batch and persists work queued after its first failure", async () => {
    const newerQueued = createDeferred();
    const { writer, errors, database } = writerFixture(undefined, (count) => {
      // Every attempt to insert an audit event kills the real worker again.
      pruneFault.enable(2);
      if (count === 1) {
        recorder.recordMessage(messageEvent("message.outbound.queued"));
        newerQueued.resolve();
      }
    });
    const recorder = messageRecorder(writer);
    try {
      await writer.ready;
      pruneFault.enable(2);
      expect(writer.record({ ...input(), sourceId: "poison" })).toBe(true);
      await newerQueued.promise;
      await recorder.stop();

      const owner = openOpenClawStateDatabase(database).db;
      expect(rowCounts(owner, ["audit_events", "outbound_message_progress"])).toEqual([0, 1]);
      expect(errors).toHaveBeenCalledTimes(3);
    } finally {
      await recorder.stop();
    }
  });

  it("keeps earlier family commits and later cleanup when one prune transaction fails", async () => {
    const database = {
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-prune-failure-") },
    };
    const options = { ...database, database: openOpenClawStateDatabase(database) };
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const receipt = decisionReceipt();
    recordAuditEventInDatabase(input(), options);
    prepareExecutionIdentityContextAtAdmission(admissionFacts(receipt.runId), {
      ...options,
      contextId: receipt.contextId,
      executionId: receipt.executionId,
    });
    recordExecutionDecisionFactInDatabase(receipt, { ...options, now: 0 });
    recordOutboundMessageProgressInDatabase(
      {
        sourceId: "prune-progress",
        sourceSequence: 1,
        occurredAt: 0,
        kind: "message",
        action: "message.outbound.queued",
        status: "started",
        outcome: "queued",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "prune-run",
        direction: "outbound",
        channel: "qa-channel",
        conversationKind: "direct",
        targetId: "synthetic-target",
      },
      options,
    );
    clock.mockRestore();
    await closeOpenClawStateDatabaseAsync();

    pruneFault.enable();
    expect(
      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(database), {
        type: "audit.writer.prune",
        input: undefined,
      }),
    ).toEqual([
      { status: "settled", deleted: 1 },
      { status: "settled", error: expect.stringContaining("synthetic identity prune failure") },
      { status: "settled", deleted: 1 },
      { status: "settled", deleted: 1 },
    ]);
    pruneFault.disable();
    await closeOpenClawStateDatabaseAsync();
    expect(
      rowCounts(openOpenClawStateDatabase(database).db, [
        "audit_events",
        "execution_identity_contexts",
        "execution_decision_facts",
        "outbound_message_progress",
      ]),
    ).toEqual([0, 1, 0, 0]);
  });
});
