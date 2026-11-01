import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AuditEventInput,
  OutboundMessageProgressInput,
} from "../../audit/audit-event-types.js";
import {
  captureExecutionIdentityAdmissionEnvelope,
  executionIdentityFacts,
} from "../../audit/execution-identity.test-support.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../cron/store.js";
import { makeStore } from "../../cron/store.test-support.js";
import {
  insertOperatorApproval,
  listCronStandingGrants,
  resolveOperatorApproval,
} from "../../gateway/operator-approval-store.js";
import type { NewOperatorApproval } from "../../gateway/operator-approval-store.types.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import {
  advancePlacementFixtureToActive,
  seedAttachedPlacementEnvironment,
} from "../../gateway/worker-environments/placement-test-fixtures.js";
import { NodeWorkerJournalWorker } from "../../node-host/node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "../../node-host/node-worker-launch-store.js";
import { requireNodeWorkerProcessIdentity } from "../../node-host/node-worker-process-identity.js";
import { NodeWorkerTurnStore } from "../../node-host/node-worker-turn-store.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function approval(id: string, now: number): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: "echo synthetic",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    source: { agentId: "main", runId: `run-${id}`, toolName: "exec" },
    runtimeEpoch: "pgfacts-runtime",
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  };
}

function rows(sql: string) {
  return admit(() => openOpenClawStateDatabase().db.prepare(sql).all());
}

function launchClaim(prefix: string) {
  return {
    launchId: `${prefix}-launch`,
    planHash: "a".repeat(64),
    gatewayNamespace: `${prefix}-gateway`,
    environmentId: `${prefix}-environment`,
    sessionId: `${prefix}-session`,
    ownerEpoch: 1,
    placementGeneration: 1,
    runId: `${prefix}-run`,
  };
}

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s first-use owner schema admission",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    it("persists launch and turn journal receipts through their state worker", async () => {
      const journal = new NodeWorkerJournalWorker({});
      const launches = new NodeWorkerLaunchStore(journal);
      const turns = new NodeWorkerTurnStore(journal);
      const supervisor = requireNodeWorkerProcessIdentity(process.pid);
      const claim = launchClaim("pgfacts");
      try {
        expect(await launches.claim(claim, supervisor, 1)).toMatchObject({
          action: "start",
          receipt: { launchId: claim.launchId, state: "pending" },
        });
        expect(
          await turns.claim({ claim, ownerLaunchId: claim.launchId, supervisor }),
        ).toMatchObject({ action: "start", receipt: { launchId: claim.launchId } });
        await launches.markRunning({
          ...claim,
          supervisor,
          worker: supervisor,
          cleanupMode: "process-group",
        });
        expect(
          await turns.finish({
            ownerLaunchId: claim.launchId,
            supervisor,
            worker: supervisor,
            expected: claim,
            state: "completed",
            resultJson: '{"marker":"pgfacts-turn"}',
          }),
        ).toMatchObject({ state: "completed", resultJson: '{"marker":"pgfacts-turn"}' });
        expect(await turns.get(claim.launchId)).toMatchObject({
          state: "completed",
          resultJson: '{"marker":"pgfacts-turn"}',
        });
        const next = { ...claim, launchId: "pgfacts-next-turn", runId: "pgfacts-next-run" };
        const now = Date.now();
        await turns.claim({
          claim: next,
          ownerLaunchId: claim.launchId,
          supervisor,
          worker: supervisor,
          nowMs: now + 2,
        });
        // A predecessor only knows the physical journal; the next read settles its turn.
        admit(() =>
          runOpenClawStateWriteTransaction(({ db }) =>
            db
              .prepare(`UPDATE node_worker_launches SET state = 'failed',
              error_text = 'synthetic predecessor', completed_at_ms = ?, updated_at_ms = ?
              WHERE launch_id = ?`)
              .run(now + 1, now + 1, claim.launchId),
          ),
        );
        const recovered = await turns.get(next.launchId);
        expect(recovered).toMatchObject({
          state: "failed",
          resultJson: null,
          errorText: "synthetic predecessor",
          completedAtMs: now + 2,
          updatedAtMs: now + 2,
        });
        expect(await turns.get(next.launchId)).toEqual(recovered);
        expect(await turns.get(claim.launchId)).toMatchObject({
          state: "completed",
          resultJson: '{"marker":"pgfacts-turn"}',
        });
        // Ordinary settlement may update zero rows after all turns are recorded.
        await launches.finish({ ...claim, supervisor, worker: supervisor, state: "failed" });
        expect(await turns.get(next.launchId)).toEqual(recovered);

        const cancelled = { ...claim, launchId: "pgfacts-cancelled", runId: "pgfacts-cancel-run" };
        await launches.claim(cancelled, supervisor, 1);
        await turns.claim({ claim: cancelled, ownerLaunchId: cancelled.launchId, supervisor });
        await launches.finishCancelled({ expected: cancelled, supervisor, worker: null });
        expect(await turns.get(cancelled.launchId)).toMatchObject({
          state: "cancelled",
          errorText: "node worker launch cancelled",
        });
      } finally {
        await journal.drain();
      }
    });

    it("returns launch claim postimages for successful and zero-row reclaims", async () => {
      const journal = new NodeWorkerJournalWorker({});
      const launches = new NodeWorkerLaunchStore(journal);
      const supervisor = requireNodeWorkerProcessIdentity(process.pid);
      const predecessor = { pid: 2_147_483_647, startTime: 1 };
      const claim = launchClaim("postimage");
      const now = Date.now();
      const expectPostimage = async (
        result: Awaited<ReturnType<typeof launches.claim>>,
        action: "start" | "replay",
        receipt: object,
      ) => {
        expect(result).toMatchObject({ action, receipt });
        expect(result).toEqual({
          action,
          nonterminalCount: 1,
          receipt: await launches.get(claim.launchId),
        });
      };
      try {
        const created = await launches.claim(claim, predecessor, 1, now + 7);
        await expectPostimage(created, "start", {
          supervisor: predecessor,
          state: "pending",
          updatedAtMs: now + 7,
        });
        const reclaimed = await launches.claim(claim, supervisor, 1, now);
        await expectPostimage(reclaimed, "start", {
          supervisor,
          state: "pending",
          updatedAtMs: now + 7,
        });
        const bootId = (await launches.get(claim.launchId))?.bootId;
        admit(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            db.prepare(`UPDATE node_worker_launches SET supervisor_pid = ?,
              supervisor_start_time = ? WHERE launch_id = ?`).run(
              predecessor.pid,
              predecessor.startTime,
              claim.launchId,
            );
            db.prepare("UPDATE node_worker_launch_boots SET boot_id = ? WHERE launch_id = ?").run(
              "synthetic-old-boot",
              claim.launchId,
            );
            // Exercise an actual zero-row write while preserving every launch constraint.
            db.exec(
              engine === "sqlite"
                ? `CREATE TRIGGER skip_reclaim BEFORE UPDATE OF supervisor_pid ON node_worker_launches
                   WHEN OLD.launch_id = 'postimage-launch' BEGIN SELECT RAISE(IGNORE); END`
                : `CREATE FUNCTION skip_reclaim() RETURNS trigger LANGUAGE plpgsql AS
                     $$ BEGIN RETURN NULL; END $$;
                   CREATE TRIGGER skip_reclaim BEFORE UPDATE OF supervisor_pid ON node_worker_launches
                     FOR EACH ROW WHEN (OLD.launch_id = 'postimage-launch')
                     EXECUTE FUNCTION skip_reclaim()`,
            );
          }),
        );
        const noClaim = await launches.claim(claim, supervisor, 1, now + 20);
        await expectPostimage(noClaim, "replay", {
          supervisor: predecessor,
          worker: null,
          state: "pending",
          updatedAtMs: now + 7,
        });
        if (bootId) {
          expect(noClaim).toHaveProperty("receipt.bootId", bootId);
        } else {
          expect(noClaim).not.toHaveProperty("receipt.bootId");
        }
      } finally {
        await journal.drain();
      }
    });

    it("persists a placement move and reads the same pending intent", async () => {
      const database = admit(() => openOpenClawStateDatabase());
      const store = createWorkerSessionPlacementStore();
      admit(() =>
        seedAttachedPlacementEnvironment(database, {
          sessionId: "pgfacts-move-session",
          environmentId: "pgfacts-move-environment",
          ownerEpoch: 7,
        }),
      );
      const active = await advancePlacementFixtureToActive(
        store,
        database,
        {
          agentId: "main",
          sessionId: "pgfacts-move-session",
          sessionKey: "agent:main:pgfacts-move",
        },
        { environmentId: "pgfacts-move-environment", seedEnvironment: false },
      );
      const source = {
        generation: active.generation,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      };
      const begun = await store.beginPlacementMove({
        sessionId: active.sessionId,
        source,
        target: { kind: "gateway" },
      });
      expect(begun).toMatchObject({
        joined: false,
        placement: { state: "draining" },
        intent: { sessionId: active.sessionId, source, target: { kind: "gateway" } },
      });
      expect(await store.getWithMoveAsync(active.sessionId)).toMatchObject({
        move: { operationId: begun.intent.operationId },
      });
    });

    it("retains the execution identity with a newly inserted approval", async () => {
      const now = Date.now();
      expect(
        await insertOperatorApproval({
          approval: {
            ...approval("pgfacts-bound", now),
            executionIdentityToken: {
              tokenVersion: 1,
              createdAt: now,
              runId: "run-pgfacts-bound",
              contextId: "pgfacts-approval-context",
              executionId: "pgfacts-approval-execution",
            },
          },
        }),
      ).toMatchObject({ outcome: "inserted" });
      expect(rows("SELECT * FROM operator_approval_execution_identities")).toContainEqual({
        approval_id: "pgfacts-bound",
        source_context_id: "pgfacts-approval-context",
        source_execution_id: "pgfacts-approval-execution",
      });
    });

    it("mints a durable standing grant during approval resolution", async () => {
      const storePath = path.join(fixture.root, "cron", "pgfacts-grant.json");
      const job = makeStore("pgfacts-grant-job", false).jobs[0]!;
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const loaded = (await loadCronJobsStore(storePath)).jobs[0]!;
      const now = Date.now();
      await insertOperatorApproval({ approval: approval("pgfacts-grant", now) });
      expect(
        await resolveOperatorApproval({
          id: "pgfacts-grant",
          decision: "allow-always",
          resolver: { kind: "device", id: "pgfacts-reviewer" },
          nowMs: now + 1,
          standingGrant: {
            kind: "cron",
            agentId: "main",
            cronJobId: loaded.id,
            jobConfigRevision: resolveCronJobConfigRevision(loaded),
            operationBinding: "pgfacts-operation",
            expiresAtMs: null,
          },
        }),
      ).toMatchObject({ outcome: "resolved" });
      expect(await listCronStandingGrants()).toContainEqual(
        expect.objectContaining({
          mintedByApprovalId: "pgfacts-grant",
          cronJobId: loaded.id,
          operationBinding: "pgfacts-operation",
        }),
      );
    });

    it("persists outbound progress and terminal execution bindings through the audit worker", async () => {
      const now = Date.now();
      const context = captureOpenClawStateWorkerContext();
      const envelope = captureExecutionIdentityAdmissionEnvelope(
        executionIdentityFacts("pgfacts-outbound-run"),
        { now, contextId: "pgfacts-context", executionId: "pgfacts-execution" },
      );
      const base = {
        sourceId: "pgfacts-message",
        sourceSequence: 1,
        occurredAt: now,
        kind: "message" as const,
        actorType: "agent" as const,
        actorId: "main",
        agentId: "main",
        runId: envelope.runId,
        direction: "outbound" as const,
        channel: "qa-channel",
        conversationKind: "direct" as const,
        executionIdentityToken: {
          tokenVersion: 1 as const,
          contextId: envelope.contextId,
          executionId: envelope.executionId,
          runId: envelope.runId,
          createdAt: now,
        },
      };
      const progress: OutboundMessageProgressInput = {
        ...base,
        action: "message.outbound.queued",
        status: "started",
        outcome: "queued",
      };
      const terminal: AuditEventInput = {
        ...base,
        sourceId: "pgfacts-message-terminal",
        sourceSequence: 2,
        action: "message.outbound.finished",
        status: "succeeded",
        outcome: "sent",
      };
      expect(
        await executeOpenClawStateWorker(context, {
          type: "audit.writer.process",
          input: [
            { type: "record-execution-identity", work: { kind: "capture", envelope } },
            { type: "record-event", eventId: "pgfacts-progress", input: progress },
            { type: "record-event", eventId: "pgfacts-terminal", input: terminal },
          ],
        }),
      ).toEqual([{ status: "settled" }, { status: "settled" }, { status: "settled" }]);
      expect(rows("SELECT source_id, outcome FROM outbound_message_progress")).toContainEqual({
        source_id: "pgfacts-message",
        outcome: "queued",
      });
      expect(rows("SELECT * FROM outbound_message_execution_bindings")).toContainEqual({
        event_id: "pgfacts-terminal",
        context_id: envelope.contextId,
        execution_id: envelope.executionId,
        run_id: envelope.runId,
      });
    });

    it("retains cron execution metadata through its production state command", async () => {
      const context = captureOpenClawStateWorkerContext();
      expect(
        await executeOpenClawStateWorker(context, {
          type: "cron.bindReceiptExecution",
          input: {
            receiptId: "pgfacts-receipt",
            binding: { contextId: "pgfacts-cron-context", executionId: "pgfacts-cron-execution" },
          },
        }),
      ).toBe(true);
      expect(rows("SELECT * FROM execution_owner_lifecycle_bindings")).toContainEqual({
        owner_kind: "cron",
        owner_id: "pgfacts-receipt",
        context_id: "pgfacts-cron-context",
        execution_id: "pgfacts-cron-execution",
      });
    });
  },
);
