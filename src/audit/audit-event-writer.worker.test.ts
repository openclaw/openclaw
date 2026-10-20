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
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createAgentEventAuditRecorder } from "./agent-event-audit.js";
import { listAuditEvents, recordAuditEventInDatabase } from "./audit-event-store.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
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
  captureExecutionIdentityAdmissionEnvelope,
  persistExecutionIdentityAdmissionEnvelope,
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

let restoreConstructor: (() => void) | undefined;
afterEach(async () => {
  restoreConstructor?.();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("audit writer shared worker", () => {
  it("records a warm run start and finish with one worker request", async () => {
    const stateDir = tempDirs.make("openclaw-audit-run-pair-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      scheduler: createTestGatewayScheduler(),
      stateDir,
      onError: (error) => errors.push(error),
    });
    const recorder = createAgentEventAuditRecorder({ writer, getConfig: () => ({}) });
    await writer.ready;
    expect(writer.record({ ...input(), sourceId: "warm-seed", runId: "warm-seed" })).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect((await listAuditEvents({ database, limit: 10 })).events).toHaveLength(1);
    let requests = 0;
    const stopObserving = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "worker.request" &&
          event.phase === "queued" &&
          event.requestClass === "audit.writer.process"
        ) {
          requests += 1;
        }
      },
      { include: ["worker.request"] },
    );
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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const duringTurn = (await listAuditEvents({ database, limit: 10 })).events;
      recorder.record({ ...event, seq: 2, data: { phase: "end" } });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const events = (await listAuditEvents({ database, limit: 10 })).events.filter(
        ({ runId }) => runId === event.runId,
      );
      expect(events.map(({ action }) => action).toSorted()).toEqual([
        "agent.run.finished",
        "agent.run.started",
      ]);
      expect(requests, "warm audit worker request count").toBe(1);
      expect(duringTurn).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await recorder.stop();
      stopObserving();
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
      const receipt = decisionReceipt();
      const token = createExecutionIdentityAdmissionToken(receipt.runId, {
        contextId: receipt.contextId,
        executionId: receipt.executionId,
        now: receipt.occurredAt,
      });
      const errors: string[] = [];
      const native = requireNodeSqlite();
      const originalConstructor = native.DatabaseSync;
      let nativeOpens = 0;
      native.DatabaseSync = new Proxy(originalConstructor, {
        construct(target, args, newTarget) {
          nativeOpens += 1;
          return Reflect.construct(target, args, newTarget);
        },
      });
      restoreConstructor = () => {
        native.DatabaseSync = originalConstructor;
        restoreConstructor = undefined;
      };
      const calibration = openNodeSqliteDatabase(":memory:");
      calibration.close();
      expect(nativeOpens).toBe(1);
      nativeOpens = 0;
      const counters = observeMainThreadSql({ includeClose: true });
      let processRequests = 0;
      const stopObserving = onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "worker.request" &&
            event.phase === "queued" &&
            event.requestClass === "audit.writer.process"
          ) {
            processRequests += 1;
          }
        },
        { include: ["worker.request"] },
      );
      const writer = createAuditEventWriter({
        scheduler: createTestGatewayScheduler(),
        stateDir,
        onError: (error) => errors.push(error),
      });
      const recorder = createAuditEventRecorder({
        scheduler: createTestGatewayScheduler(),
        getConfig: () => ({ logging: { audit: { messages: "all" } } }),
        writer,
      });
      const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
      try {
        await writer.ready;
        if (mode === "worker death after committed prefix") {
          pruneFault.enable(1);
        }
        expect(
          enqueueExecutionIdentityContextAtAdmission(
            {
              runId: receipt.runId,
              agentId: "main",
              ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
              runtime: { kind: "embedded" },
            },
            { enabled: true, token, runtimeInstanceId: "worker-runtime" },
          )?.accepted,
        ).toBe(true);
        expect(writer.recordExecutionDecision(receipt)).toBe(true);
        expect(
          writer.recordExecutionDecisionWork({
            workVersion: 1,
            token,
            receipt: {
              schemaVersion: receipt.schemaVersion,
              receiptId: "worker-private-decision",
              occurredAt: receipt.occurredAt + 1,
              action: receipt.action,
              decision: receipt.decision,
              enforcement: receipt.enforcement,
              source: receipt.source,
              missingEvidence: receipt.missingEvidence,
              remediation: receipt.remediation,
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
          runId: receipt.runId,
          executionIdentityToken: token,
        });
      } finally {
        clearSink();
        try {
          await recorder.stop();
          expect(nativeOpens).toBe(0);
          counters.expectIdle();
        } finally {
          stopObserving();
          counters.restore();
          restoreConstructor();
        }
      }

      const replayed = mode === "worker death after committed prefix";
      const owner = openOpenClawStateDatabase(database).db;
      expect(owner.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
        count: 3,
      });
      expect(
        owner.prepare("SELECT COUNT(*) AS count FROM outbound_message_execution_bindings").get(),
      ).toEqual({ count: 1 });
      expect(errors).toHaveLength(replayed ? 1 : 0);
      expect(processRequests).toBe(replayed ? 2 : 1);
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
      expect(
        owner.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get(),
      ).toEqual({
        count: 1,
      });
      expect(
        owner.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'message'").get(),
      ).toEqual({
        count: 1,
      });
      const decisions = pageExecutionDecisionFactsForContextInDatabase(owner, {
        context: token,
        limit: 10,
        now: receipt.occurredAt + 1,
      }).receipts;
      expect(decisions).toHaveLength(2);
      expect(decisions).toContainEqual(receipt);
      expect(decisions).toContainEqual(
        expect.objectContaining({
          receiptId: "worker-private-decision",
          action: expect.objectContaining({
            targetRef: expect.stringMatching(/^hmac-sha256:v1:/u),
          }),
        }),
      );

      expect(owner.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    },
  );

  it("drops a repeatedly crashing batch and persists work queued after its first failure", async () => {
    const stateDir = tempDirs.make("openclaw-audit-poison-batch-");
    const newerQueued = createDeferred();
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      scheduler: createTestGatewayScheduler(),
      stateDir,
      onError: (error) => {
        errors.push(error);
        // Every attempt to insert an audit event kills the real worker again.
        pruneFault.enable(2);
        if (errors.length === 1) {
          recorder.recordMessage(messageEvent("message.outbound.queued"));
          newerQueued.resolve();
        }
      },
    });
    const recorder = createAuditEventRecorder({
      scheduler: createTestGatewayScheduler(),
      getConfig: () => ({ logging: { audit: { messages: "all" } } }),
      writer,
    });
    try {
      await writer.ready;
      pruneFault.enable(2);
      expect(writer.record({ ...input(), sourceId: "poison" })).toBe(true);
      await newerQueued.promise;
      await recorder.stop();

      const owner = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).db;
      expect(owner.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
        count: 0,
      });
      expect(
        owner.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get(),
      ).toEqual({
        count: 1,
      });
      expect(errors).toHaveLength(3);
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
    try {
      const receipt = decisionReceipt();
      recordAuditEventInDatabase(input(), options);
      persistExecutionIdentityAdmissionEnvelope(
        captureExecutionIdentityAdmissionEnvelope(
          {
            runId: receipt.runId,
            agentId: "main",
            ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
            runtime: { kind: "embedded" },
          },
          {
            now: 0,
            contextId: receipt.contextId,
            executionId: receipt.executionId,
            runtimeInstanceId: "prune-runtime",
          },
        ),
        { ...options, now: 0 },
      );
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
    } finally {
      clock.mockRestore();
    }
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
      openOpenClawStateDatabase(database)
        .db.prepare(`
          SELECT
            (SELECT count(*) FROM audit_events) AS events,
            (SELECT count(*) FROM execution_identity_contexts) AS identity_contexts,
            (SELECT count(*) FROM execution_decision_facts) AS decisions,
            (SELECT count(*) FROM outbound_message_progress) AS progress
        `)
        .get(),
    ).toEqual({ events: 0, identity_contexts: 1, decisions: 0, progress: 0 });
  });
});
