import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listAuditEvents } from "./audit-event-store.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import { input, messageEvent, decisionReceipt } from "./audit-event-writer.test-support.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { pageExecutionDecisionFactsForContextInDatabase } from "./execution-decision-facts.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "./execution-identity-admission.js";

let restoreConstructor: (() => void) | undefined;
afterEach(async () => {
  restoreConstructor?.();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("audit writer shared worker", () => {
  it.each(["cold", "existing shared actor"] as const)(
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
      let eventLoopTicks = 0;
      const progress = setInterval(() => {
        eventLoopTicks += 1;
      }, 1);
      const counters = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        vi.spyOn(native.DatabaseSync.prototype, "close"),
        ...(["get", "all", "run", "iterate"] as const).map((operation) =>
          vi.spyOn(native.StatementSync.prototype, operation),
        ),
      ];
      const startedAt = performance.now();
      const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
      const recorder = createAuditEventRecorder({ messageMode: "all", writer });
      const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
      let hostSqlCounts: number[];
      let readyMs = 0;
      let readyTicks = 0;
      let batchStartedAt = startedAt;
      let batchDrainMs = 0;
      let stopMs = 0;
      try {
        await writer.ready;
        readyMs = performance.now() - startedAt;
        readyTicks = eventLoopTicks;
        batchStartedAt = performance.now();
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
        expect(writer.record(input())).toBe(true);
        recorder.recordMessage(messageEvent("message.outbound.queued"));
        recorder.recordMessage(messageEvent("message.outbound.finished"));
      } finally {
        clearSink();
        try {
          const stopStartedAt = performance.now();
          await recorder.stop();
          stopMs = performance.now() - stopStartedAt;
          batchDrainMs = performance.now() - batchStartedAt;
        } finally {
          clearInterval(progress);
          hostSqlCounts = [nativeOpens, ...counters.map((counter) => counter.mock.calls.length)];
          counters.forEach((counter) => counter.mockRestore());
          restoreConstructor();
        }
      }

      expect(errors).toEqual([]);
      const owner = openOpenClawStateDatabase(database).db;
      expect(
        owner.prepare("SELECT run_id FROM audit_events WHERE kind = 'agent_run'").get(),
      ).toEqual({
        run_id: "run-1",
      });
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
      expect(hostSqlCounts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      console.info(
        "audit writer probe",
        JSON.stringify({
          mode,
          node: process.versions.node,
          requests: 6,
          constructorCalibrationOpens: 1,
          readyMs,
          batchDrainMs,
          stopMs,
          eventLoopTicks: { readiness: readyTicks, drain: eventLoopTicks - readyTicks },
          hostSqlCounts,
        }),
      );
    },
  );
});
