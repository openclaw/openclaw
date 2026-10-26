import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
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
import { progressInput } from "./audit-event-retention.test-support.js";
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
import {
  executionIdentityFacts as admissionFacts,
  prepareExecutionIdentityContextAtAdmission,
} from "./execution-identity.test-support.js";
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

describe("audit writer shared worker", () => {
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
      const counters = observeMainThreadSql({ includeClose: true });
      const { writer, errors } = writerFixture(stateDir);
      const recorder = messageRecorder(writer);
      const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
      try {
        await writer.ready;
        if (mode === "worker death after committed prefix") {
          pruneFault.enable(1);
        }
        enqueueExecutionIdentityContextAtAdmission(admissionFacts(runId), {
          enabled: true,
          token,
          runtimeInstanceId: "worker-runtime",
        });
        writer.recordExecutionDecision({ ...receipt, contextId, executionId, runId });
        writer.recordExecutionDecisionWork({
          workVersion: 1,
          token,
          receipt: {
            ...receipt,
            receiptId: "worker-private-decision",
            occurredAt: receipt.occurredAt + 1,
          },
          refs: { target: { namespace: "session", value: "private-session-target" } },
        });
        recorder.recordMessage({
          ...messageEvent("message.outbound.queued"),
          accountId: "raw-account",
          conversationId: "raw-conversation",
        });
        const start = input();
        writer.recordRun(start, {
          ...start,
          sourceId: "paired-finish",
          sourceSequence: 2,
          action: "agent.run.finished",
          status: "succeeded",
        });
        recorder.recordMessage({
          ...messageEvent("message.outbound.finished"),
          runId,
          executionIdentityToken: token,
        });
      } finally {
        clearSink();
        await recorder.stop();
        expect(nativeOpens).not.toHaveBeenCalled();
        counters.expectIdle();
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
      expect(
        JSON.stringify(owner.prepare("SELECT * FROM outbound_message_progress").all()),
      ).not.toMatch(/raw-account|raw-conversation|raw-target/);
      expect(errors).toHaveBeenCalledTimes(replayed ? 1 : 0);
      expect(
        owner
          .prepare("SELECT action FROM audit_events WHERE kind = 'agent_run' ORDER BY sequence")
          .all()
          .map(({ action }) => action),
      ).toEqual(["agent.run.started", "agent.run.finished"]);
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
    recordOutboundMessageProgressInDatabase(progressInput(), options);
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
