import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import { withSqliteWorkerReservationObservation } from "../infra/worker-request-diagnostics.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
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
import {
  input,
  messageEvent,
  decisionReceipt,
  captureWork,
} from "./audit-event-writer.test-support.js";
import type { AuditWriterRequest } from "./audit-event-writer.types.js";
import { auditOperations } from "./audit-event-writer.worker.js";
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
  captureExecutionIdentityAdmissionEnvelope,
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

function databaseFixture() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-audit-writer-") } };
}

function identityFixture() {
  const receipt = decisionReceipt();
  const options = { ...receipt, now: receipt.occurredAt, runtimeInstanceId: "worker-runtime" };
  const token = createExecutionIdentityAdmissionToken(receipt.runId, options);
  return { receipt, token, options };
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
  const errors = vi.fn<(error: string) => void>(() => onError?.(errors.mock.calls.length));
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

function loseFirstAuditBatchReply() {
  let target: { worker: Worker; requestId: number } | undefined;
  let stopped: Promise<number> | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalPost = Worker.prototype.postMessage;
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalEmit = Worker.prototype.emit;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (isRecord(command) && command.type === "audit.writer.process") {
        target ??= { worker: this, requestId: request.id };
      }
    }
    return originalPost.call(this, request, transferList);
  });
  const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event,
    ...args: unknown[]
  ) {
    const reply = args[0];
    if (
      event === "message" &&
      !stopped &&
      target?.worker === this &&
      isRecord(reply) &&
      reply.id === target.requestId &&
      reply.ok === true
    ) {
      // The real worker committed; discard only its acknowledgement and force replay.
      stopped = this.terminate();
      return true;
    }
    return originalEmit.call(this, event, ...args);
  });
  return async () => {
    await stopped;
    post.mockRestore();
    emit.mockRestore();
    expect(stopped).toBeDefined();
  };
}
describe("audit writer shared worker", () => {
  it.each([[2], [10], [32], [10, "ABORT"], [10, "ROLLBACK"], [32, "message"]] as const)(
    "commits %i items with statement isolation (%s)",
    async (size, failure?: "ABORT" | "ROLLBACK" | "message") => {
      const database = databaseFixture();
      const opened = openOpenClawStateDatabase(database);
      const message = failure === "message";
      recordAuditEventInDatabase(input(), { ...database, database: opened }, "seed");
      if (failure && !message) {
        opened.db.exec(`CREATE TEMP TRIGGER reject_middle BEFORE INSERT ON audit_events
          WHEN NEW.source_sequence = 2 BEGIN SELECT RAISE(${failure}, 'synthetic insert failure'); END`);
      }
      const requests = Array.from({ length: size }, (_, index) => ({
        type: "record-event" as const,
        eventId: `batch-${index}`,
        input: {
          ...(message ? messageEvent("message.outbound.finished") : input()),
          sourceId: `batch-${index}`,
          sourceSequence: message && index === 1 ? 0 : index + 1,
        },
      }));
      const ctx = { open: () => opened, stateOptions: () => ({ ...database, path: opened.path }) };
      const execute = () =>
        message
          ? executeOpenClawStateWorker(captureOpenClawStateWorkerContext(database), {
              type: "audit.writer.process",
              input: requests,
            })
          : auditOperations["audit.writer.process"](requests, ctx);
      const sql = observeMainThreadSql({
        onStatement: () => expect(opened.db.isTransaction).toBe(true),
      });
      const expected = requests.map((_, index) => ({
        status: "settled",
        error: failure && (failure === "ROLLBACK" || index === 1) ? expect.any(String) : undefined,
      }));
      const observation = { operations: new Set<string>(), transactionCount: 0 };
      expect(await withSqliteWorkerReservationObservation(observation, execute)).toEqual(expected);
      if (message) {
        expect(observation.transactionCount).toBe(1);
      } else if (!failure) {
        expect(sql.calls.at(1)?.mock.calls).toEqual([["BEGIN IMMEDIATE"], ["COMMIT"]]);
        expect(sql.calls.slice(1).reduce((n, c) => n + c.mock.calls.length, 0)).toBe(size + 2);
      }
      sql.restore();
      expect(await execute()).toEqual(expected);
      expect(opened.db.isTransaction).toBe(false);
      const persisted = requests.filter((_, i) => failure !== "ROLLBACK" && (!failure || i !== 1));
      expect(
        opened.db.prepare("SELECT event_id FROM audit_events ORDER BY sequence").all(),
      ).toEqual([{ event_id: "seed" }, ...persisted.map(({ eventId }) => ({ event_id: eventId }))]);
    },
  );

  it("retries a failed batch commit on the same handle without retaining rolled-back facts", () => {
    const database = databaseFixture();
    const opened = openOpenClawStateDatabase(database);
    const { receipt, token, options } = identityFixture();
    const envelope = captureExecutionIdentityAdmissionEnvelope(
      admissionFacts(receipt.runId),
      options,
    );
    const requests: AuditWriterRequest[] = [
      { type: "record-execution-identity", work: captureWork(envelope) },
      { type: "record-execution-decision", receipt },
      {
        type: "record-event",
        eventId: "rollback-progress",
        input: progressInput("message.outbound.queued", {
          runId: receipt.runId,
          executionIdentityToken: token,
        }),
      },
      {
        type: "record-event",
        eventId: "rollback-terminal",
        input: {
          ...messageEvent("message.outbound.finished"),
          sourceId: "rollback-terminal-source",
          sourceSequence: 1,
          runId: receipt.runId,
          executionIdentityToken: token,
        },
      },
    ];
    const context = {
      open: () => opened,
      stateOptions: () => ({ path: opened.path, env: database.env }),
    };
    const nativeExec = opened.db.exec.bind(opened.db);
    let failCommit = true;
    vi.spyOn(opened.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && failCommit) {
        failCommit = false;
        throw new Error("synthetic batch commit failure");
      }
      return nativeExec(sql);
    });
    expect(auditOperations["audit.writer.process"](requests, context)).toEqual(
      requests.map(() => ({ status: "settled", error: expect.any(String) })),
    );
    expect(failCommit).toBe(false);
    expect(opened.db.isTransaction).toBe(false);
    expect(rowCounts(opened.db, ["audit_events", "audit_identity_keys"])).toEqual([0, 0]);
    const companions = [
      "execution_identity_contexts",
      "execution_decision_facts",
      "outbound_message_progress",
      "outbound_message_execution_bindings",
    ];
    expect(companions.filter((table) => tableExists(opened.db, table))).toEqual([]);

    expect(auditOperations["audit.writer.process"](requests, context)).toEqual(
      requests.map(() => ({ status: "settled" })),
    );
    expect(rowCounts(opened.db, ["audit_events", "audit_identity_keys", ...companions])).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    expect(opened.db.prepare("SELECT event_id FROM audit_events").all()).toEqual([
      { event_id: "rollback-terminal" },
    ]);
  });

  it.each([
    "cold",
    "existing shared actor",
    "worker death before batch commit",
    "worker death after batch commit",
  ] as const)("flushes the %s audit FIFO without host SQLite", async (mode) => {
    const database = databaseFixture();
    if (mode === "existing shared actor") {
      await listAuditEvents({ database, limit: 1 });
    }
    const { receipt: fullReceipt, token, options } = identityFixture();
    const { contextId, executionId, runId, ...receipt } = fullReceipt;
    const nativeOpens = vi.spyOn(requireNodeSqlite(), "DatabaseSync");
    const counters = observeMainThreadSql({ includeClose: true });
    const { writer, errors } = writerFixture(database.env.OPENCLAW_STATE_DIR);
    const recorder = messageRecorder(writer);
    const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
    let restoreLostReply: (() => Promise<void>) | undefined;
    try {
      await writer.ready;
      if (mode === "worker death before batch commit") {
        pruneFault.enable(1);
      } else if (mode === "worker death after batch commit") {
        restoreLostReply = loseFirstAuditBatchReply();
      }
      enqueueExecutionIdentityContextAtAdmission(admissionFacts(runId), {
        ...options,
        enabled: true,
        token,
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
      await restoreLostReply?.();
      expect(nativeOpens).not.toHaveBeenCalled();
      counters.expectIdle();
    }

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
    expect(errors).toHaveBeenCalledTimes(mode.startsWith("worker death") ? 1 : 0);
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
    expect(decisions).toContainEqual(fullReceipt);
    expect(
      decisions.find((item) => item.receiptId === "worker-private-decision")?.action.targetRef,
    ).toMatch(/^hmac-sha256:v1:/u);
  });

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
    const database = databaseFixture();
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
