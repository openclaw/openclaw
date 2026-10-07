import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import { assertAgentDeletionAllowsMutation } from "../agents/agent-lifecycle-registry.js";
import {
  commitHeartbeatTaskMigrationInDatabase,
  loadHeartbeatTaskPlanningSnapshot,
  planHeartbeatTaskMigration,
} from "../commands/doctor-heartbeat-task-migration.kernel.js";
import { analyzeLegacyHeartbeatTasks } from "../commands/heartbeat-task-legacy.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { recordDefaultProactiveJobInDatabase } from "../cron/proactive-job-receipt.kernel.js";
import { hashCronScratchSource } from "../cron/scratch-store.js";
import { writeCronJobScratchInDatabase } from "../cron/scratch-write.kernel.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { cronStoreKey } from "../cron/store/key.js";
import { prepareCronReceiptAuthorityPublication } from "../cron/store/receipt-authority-publication.js";
import { loadCronRows, upsertCronJobRow } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { ownedWorkerBytes } from "../infra/worker-transfer-bytes.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import { reconstructClawAutomationInstallUpdate } from "./automation-install-intent.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  CLAW_PORTABLE_HEARTBEAT_ID,
  deleteClawCronRef,
  upsertClawCronRef,
} from "./cron.js";
import {
  assertPortableHeartbeatUnchanged,
  readPortableHeartbeatStateInDatabase,
} from "./portable-heartbeat-state.kernel.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";
import type {
  PortableHeartbeatMutation,
  PortableHeartbeatMutationResult,
} from "./portable-heartbeat-write.types.js";
import { readClawInstallRecordFromDatabase } from "./provenance-read.kernel.js";
import { updateClawInstallRecord } from "./provenance.js";

export function mutatePortableHeartbeatInWorker(
  database: OpenClawStateDatabase,
  input: PortableHeartbeatMutation & { nonce: string },
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
): { nonce: string } {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const assertRemovalAuthority = () => {
        if (input.kind !== "removeRef") {
          assertAgentDeletionAllowsMutation(database, input.agentId);
          return;
        }
        const { deletion } = input;
        if (
          deletion.databasePath !== database.path ||
          deletion.agentId !== input.agentId ||
          deletion.lease.scope !== "core:agent-deletion" ||
          deletion.lease.key !== input.agentId
        ) {
          throw new Error("Portable automation removal differs from its deletion owner.");
        }
        verifyOpenClawStateLeaseOwnership({
          ...deletion.lease,
          leaseLabel: "agent deletion",
          transaction: db,
        });
        const journal = readAgentDeletionJournalInDatabase({ db }, input.agentId);
        if (
          !journal ||
          journal.operationId !== deletion.operationId ||
          journal.cleanupCompleted ||
          !isDeepStrictEqual(
            readClawInstallRecordFromDatabase(db, input.agentId) ?? null,
            input.expectedInstall,
          )
        ) {
          throw new Error("Claw removal no longer owns the portable automation provenance.");
        }
      };
      assertRemovalAuthority();
      const storeKey = cronStoreKey(input.storePath);
      let current = readPortableHeartbeatStateInDatabase(db, input.agentId, input.storePath);
      if (
        ("expected" in input && input.expected && input.expected.storePath !== input.storePath) ||
        (input.kind === "rollback" && input.previous.storePath !== input.storePath)
      ) {
        throw new Error("Portable automation mutation targets a different store partition.");
      }
      if ("expected" in input && input.expected && input.kind !== "removeRef") {
        assertPortableHeartbeatUnchanged(current, input.expected);
      }
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { nonce: input.nonce },
      });
      assertRemovalAuthority();
      const nativeOptions = { ...options, database };
      const writeJob = (job: CronStoredJob) => {
        if (job.agentId !== input.agentId) {
          throw new Error("Portable automation belongs to a different agent.");
        }
        const rows = loadCronRows(db, storeKey);
        const order =
          rows.find((row) => row.job_id === job.id)?.sort_order ??
          rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1;
        return upsertCronJobRow(db, storeKey, job, order);
      };
      const writeScratch = (
        jobId: string,
        content: string | null,
        revision: number,
        sourceSha256?: string,
      ) => {
        const outcome = writeCronJobScratchInDatabase(db, {
          storeKey,
          jobId,
          content,
          expectedRevision: revision,
          nowMs: input.nowMs,
          sourceSha256,
        });
        if (!outcome.result.ok) {
          throw new Error("Portable scratch changed during mutation.");
        }
      };
      let installRecord: PortableHeartbeatMutationResult["installRecord"];
      if (input.kind === "import") {
        const sourceDigest =
          input.source.scratch === undefined
            ? undefined
            : hashCronScratchSource(input.source.scratch);
        const hasTasks =
          input.source.scratch !== undefined &&
          analyzeLegacyHeartbeatTasks(input.source.scratch).hasTasksBlock;
        if (current.receipt || current.ref) {
          const scratchMatches =
            current.receipt?.phase === "pending"
              ? current.scratch.scratch?.sourceSha256 === sourceDigest
              : current.ref?.job.scratchDigest ===
                (current.scratch.scratch
                  ? hashCronScratchSource(current.scratch.scratch.content)
                  : undefined);
          if (
            !current.receipt ||
            !current.ref ||
            !current.job ||
            current.receipt.jobId !== current.ref.schedulerJobId ||
            !isDeepStrictEqual(current.ref.job.heartbeat, input.source.heartbeat) ||
            (current.ref.job.sourceScratchDigest ?? current.ref.job.scratchDigest) !==
              sourceDigest ||
            current.job.runtimeAuthority ||
            current.job.runtimeAuthorityRecoveryRequired === true ||
            current.ref.job.configRevision !== resolveCronJobConfigRevision(current.job) ||
            !scratchMatches
          ) {
            throw new Error(
              "Portable heartbeat import conflicts with existing, edited, or deleted automation ownership; it will not be recreated. Inspect claws status.",
            );
          }
        } else {
          const written = writeJob(input.plannedJob);
          if (input.source.scratch !== undefined) {
            writeScratch(written.id, input.source.scratch, 0, hasTasks ? sourceDigest : undefined);
          }
          recordDefaultProactiveJobInDatabase(
            db,
            input.storePath,
            input.agentId,
            written.id,
            input.nowMs,
            hasTasks ? "pending" : "complete",
          );
          upsertClawCronRef(
            {
              schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
              agentId: input.agentId,
              manifestId: CLAW_PORTABLE_HEARTBEAT_ID,
              declarationKey: `claw:${input.agentId}:${CLAW_PORTABLE_HEARTBEAT_ID}`,
              schedulerJobId: written.id,
              status: hasTasks ? "pending" : "complete",
              createdAtMs: input.nowMs,
              updatedAtMs: input.nowMs,
              job: {
                heartbeat: input.source.heartbeat,
                configRevision: resolveCronJobConfigRevision(written),
                ...(hasTasks ? { sourceScratchDigest: sourceDigest } : {}),
                ...(sourceDigest === undefined ? {} : { scratchDigest: sourceDigest }),
              },
            },
            nativeOptions,
          );
        }
        let install = input.install;
        if (input.gatewayInstall) {
          if (install) {
            throw new Error("Portable automation has competing installation intents.");
          }
          const currentInstall = readClawInstallRecordFromDatabase(db, input.agentId);
          if (!currentInstall) {
            throw new Error("Portable automation install lost its Claw provenance.");
          }
          install = reconstructClawAutomationInstallUpdate({
            ...input.gatewayInstall,
            current: currentInstall,
          });
        }
        if (install) {
          if (install.plan.agent.finalId !== input.agentId) {
            throw new Error("Portable automation install targets a different agent.");
          }
          installRecord = updateClawInstallRecord(install.plan, {
            ...nativeOptions,
            nowMs: input.nowMs,
            expectedClaw: install.expectedClaw,
            agentConfigDigest: install.agentConfigDigest,
          });
        }
      } else if (input.kind === "removeRef") {
        if (
          current.job ||
          !isDeepStrictEqual(current.ref, input.expected.ref) ||
          !isDeepStrictEqual(current.receipt, input.expected.receipt)
        ) {
          throw new Error(
            "Portable automation ownership changed during removal; provenance was retained.",
          );
        }
        deleteClawCronRef(input.agentId, CLAW_PORTABLE_HEARTBEAT_ID, nativeOptions);
      } else {
        if (!current.ref || !current.job || !current.receipt) {
          throw new Error("Portable ownership is missing; no job was provisioned.");
        }
        if (input.kind === "release") {
          upsertClawCronRef(
            { ...current.ref, status: "removed", updatedAtMs: input.nowMs },
            nativeOptions,
          );
        } else if (input.kind === "completeTasks") {
          if (
            current.receipt.jobId !== input.jobId ||
            current.ref.schedulerJobId !== input.jobId ||
            !current.scratch.scratch ||
            current.ref.job.configRevision !== resolveCronJobConfigRevision(current.job) ||
            current.scratch.scratch.sourceSha256 !== input.sourceScratchDigest
          ) {
            throw new Error(
              "Portable task conversion changed or remains incomplete; source scratch and ownership were retained.",
            );
          }
          if (analyzeLegacyHeartbeatTasks(current.scratch.scratch.content).hasTasksBlock) {
            const plan = planHeartbeatTaskMigration({
              snapshot: loadHeartbeatTaskPlanningSnapshot(db, input.storePath),
              agentId: input.agentId,
              jobId: input.jobId,
              scratch: current.scratch.scratch,
              nowMs: input.nowMs,
            });
            const converted = commitHeartbeatTaskMigrationInDatabase({
              db,
              storePath: input.storePath,
              nowMs: input.nowMs,
              plan,
            });
            if (!converted.ok) {
              throw new Error(`Portable task conversion lost its ${converted.reason} owner.`);
            }
            current = readPortableHeartbeatStateInDatabase(db, input.agentId, input.storePath);
            if (!current.ref || !current.receipt || !current.scratch.scratch) {
              throw new Error("Portable task conversion lost its provisioning state.");
            }
          }
          upsertClawCronRef(
            {
              ...current.ref,
              status: "complete",
              job: {
                ...current.ref.job,
                scratchDigest: hashCronScratchSource(current.scratch.scratch.content),
              },
            },
            nativeOptions,
          );
          recordDefaultProactiveJobInDatabase(
            db,
            input.storePath,
            input.agentId,
            current.receipt.jobId,
            input.nowMs,
          );
        } else if (input.kind === "update") {
          const job: CronStoredJob = {
            ...current.job,
            enabled: input.plannedJob.enabled,
            schedule: input.plannedJob.schedule,
            activeHours: input.plannedJob.activeHours,
            sessionTarget: input.plannedJob.sessionTarget,
            sessionKey: input.plannedJob.sessionKey,
            payload: input.plannedJob.payload,
            updatedAtMs: input.nowMs,
          };
          if (job.schedule.kind === "every" && current.job.schedule.kind === "every") {
            job.schedule.anchorMs = current.job.schedule.anchorMs;
          }
          job.state = {
            ...current.job.state,
            nextRunAtMs: computeJobNextRunAtMs(job, input.nowMs),
          };
          const written = writeJob(job);
          if (input.source.scratch !== current.scratch.scratch?.content) {
            writeScratch(job.id, input.source.scratch ?? null, current.scratch.currentRevision);
          }
          upsertClawCronRef(
            {
              ...current.ref,
              updatedAtMs: input.nowMs,
              job: {
                heartbeat: input.source.heartbeat,
                configRevision: resolveCronJobConfigRevision(written),
                ...(input.source.scratch === undefined
                  ? {}
                  : { scratchDigest: hashCronScratchSource(input.source.scratch) }),
              },
            },
            nativeOptions,
          );
        } else {
          const previous: PortableHeartbeatState = input.previous;
          if (!previous.job || !previous.ref || previous.job.id !== current.job.id) {
            throw new Error("Portable automation rollback lost its original ownership.");
          }
          const runtime = isDeepStrictEqual(current.job.state, input.expected.job?.state)
            ? previous.job.state
            : {
                ...current.job.state,
                nextRunAtMs: computeJobNextRunAtMs(
                  { ...previous.job, state: current.job.state },
                  input.nowMs,
                ),
              };
          writeJob({ ...previous.job, state: runtime, updatedAtMs: input.nowMs });
          if (previous.scratch.scratch?.content !== current.scratch.scratch?.content) {
            writeScratch(
              previous.job.id,
              previous.scratch.scratch?.content ?? null,
              current.scratch.currentRevision,
            );
          }
          upsertClawCronRef(previous.ref, nativeOptions);
        }
      }
      const result: PortableHeartbeatMutationResult = {
        state: readPortableHeartbeatStateInDatabase(db, input.agentId, input.storePath),
        ...(installRecord ? { installRecord } : {}),
      };
      const bytes = ownedWorkerBytes(serialize(result));
      deferSqliteWorkerCommitReceipt(db, {
        nonce: input.nonce,
        receiptAuthority: prepareCronReceiptAuthorityPublication(db),
      });
      requestSqliteWorkerOperationAdmission(
        { stage: "commit", facts: { nonce: input.nonce, bytes } },
        [bytes.buffer],
      );
      assertRemovalAuthority();
      return { nonce: input.nonce };
    },
    { ...options, database },
    { operationLabel: "claw.portable-heartbeat" },
  );
}
