import { threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceLiveProtection,
} from "../config/sessions/session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { captureSqliteNativeRuntimeAdmission } from "../infra/node-sqlite.js";
import { repairDoctorSqliteIndexCorruption } from "../infra/sqlite-index-recovery.js";
import { SqliteIntegrityError, type SqliteIntegrityCheck } from "../infra/sqlite-integrity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { mayShareAgentDatabaseFile } from "./openclaw-agent-db-lease-provenance.js";
import {
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
  type OpenClawAgentDatabaseWorkerLeaseReceipt,
} from "./openclaw-agent-db-lease.js";
import { AGENT_FTS_SCHEMAS } from "./openclaw-agent-fts-schema.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

type PreparationInput = Omit<
  Extract<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>,
  "kind"
>;
type MetadataInput =
  | Exclude<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>
  | {
      kind: "maintenance-plan";
      protection: SessionMaintenanceLiveProtection;
    };

/** Metadata preparation and commit share the canonical actor's retained snapshots. */
export function createAgentDatabaseMaintenanceOwner(context: {
  databaseOptions: ReclamationDatabaseOptions;
  openWriter(): OpenClawAgentDatabase;
  admit(stage: "transaction" | "commit", publication?: unknown): void;
}) {
  let preparation:
    | {
        plan: PreparationInput;
        prepared: ReturnType<
          typeof import("../config/sessions/session-accessor.sqlite-maintenance-transaction.js").prepareSessionMaintenanceInWorker
        >;
      }
    | undefined;
  let maintenance:
    | typeof import("../config/sessions/session-accessor.sqlite-maintenance-transaction.js")
    | undefined;
  let replacements:
    | typeof import("../config/sessions/session-accessor.sqlite-replacement-state.js")
    | undefined;
  const releasePreparation = () => {
    if (preparation) {
      preparation.prepared.release();
      preparation = undefined;
    }
  };
  const operations = {
    "session.maintenance.prepare": (input: PreparationInput) => {
      const kernel = expectDefined(maintenance, "Session maintenance kernel");
      // Automatic maintenance coalesces per store. A stopped pass may leave
      // its bounded snapshot here until the next preparation or ordinary close.
      releasePreparation();
      const prepared = kernel.prepareSessionMaintenanceInWorker({
        kind: "maintenance-plan",
        input: input.input,
        ageChanges: input.ageChanges,
        databaseOptions: context.databaseOptions,
      });
      preparation = { plan: input, prepared };
      if (!prepared.requiresWrite) {
        try {
          const value = kernel.runSessionMaintenanceMetadataInTransaction(
            { ...input, kind: "maintenance-plan", databaseOptions: context.databaseOptions },
            {},
            prepared,
          );
          return { kind: "not-committed" as const, workerThreadId: threadId, value };
        } finally {
          releasePreparation();
        }
      }
      return undefined;
    },
    "session.maintenance.metadata": (input: MetadataInput) => {
      const kernel = expectDefined(maintenance, "Session maintenance kernel");
      const preparePublication = expectDefined(
        replacements,
        "Session replacement kernel",
      ).prepareSessionEntryReplacementPublication;
      const opened = context.openWriter();
      const previous = new Map<string, SessionEntry>();
      const current = new Map<string, SessionEntry>();
      let publication: ReturnType<typeof preparePublication> | undefined;
      const selected =
        input.kind === "maintenance-plan"
          ? expectDefined(preparation, "Session maintenance preparation")
          : undefined;
      if (selected && input.kind === "maintenance-plan") {
        Object.assign(selected.plan.input, input.protection);
      }
      const plan: SessionMaintenanceMetadataCommand =
        input.kind === "maintenance-plan"
          ? {
              ...expectDefined(selected, "Session maintenance preparation").plan,
              kind: "maintenance-plan",
            }
          : input;
      const value = kernel.runSessionMaintenanceMetadataInTransaction(
        { ...plan, databaseOptions: context.databaseOptions },
        {
          beforeMutation(database) {
            if (database.db !== opened.db) {
              throw new Error("Session maintenance lost its canonical database owner");
            }
            context.admit("transaction");
          },
          onArchived(sessionKey, before, after) {
            previous.set(sessionKey, before);
            current.set(sessionKey, after);
          },
          beforeCommit(database, maintenancePlan) {
            publication = preparePublication(
              {
                pendingArchiveRecovery: false,
                previous,
                current,
                maintenancePlans: [],
                membershipInvalidatedKeys: [],
              },
              database,
            );
            if (maintenancePlan) {
              publication.maintenancePlans = [maintenancePlan];
            }
            deferSqliteWorkerCommitReceipt(database.db, publication);
            context.admit("commit", publication);
          },
        },
        selected?.prepared,
      );
      return value.kind === "maintenance-plan-stale"
        ? { kind: "not-committed" as const, workerThreadId: threadId, value }
        : {
            kind: "committed" as const,
            workerThreadId: threadId,
            value,
            publication: expectDefined(publication, "Session maintenance commit receipt"),
          };
    },
  };
  return {
    operations,
    repairStartupIntegrity(
      receipt: OpenClawAgentDatabaseWorkerLeaseReceipt,
      check: SqliteIntegrityCheck,
      error: unknown,
      assertCurrent: () => void,
    ): boolean {
      if (
        !(error instanceof SqliteIntegrityError) ||
        !error.findings ||
        check.databaseLabel !== receipt.path
      ) {
        return false;
      }
      requestSqliteWorkerOperationAdmission({
        stage: "prepare",
        facts: { kind: "agent-startup-fts" },
      });
      const state = { env: context.databaseOptions.env, path: receipt.sharedStatePath };
      // The shared write fence excludes new leases through Doctor's backed-up repair.
      const changes = runOpenClawStateWriteTransaction(() => {
        assertCurrent();
        const owners = readActiveOpenClawAgentDatabaseLeasesReadOnly(state).filter((owner) =>
          mayShareAgentDatabaseFile(owner.path, receipt.path),
        );
        if (owners.length !== 1 || owners[0]?.lease_id !== receipt.leaseId) {
          throw new Error("Startup FTS repair requires an exclusive live agent database lease");
        }
        return repairDoctorSqliteIndexCorruption(check.database, check.databaseLabel, {
          label: `agent ${context.databaseOptions.agentId}`,
          ftsSchemas: AGENT_FTS_SCHEMAS,
          ftsOnly: true,
          assertCurrent,
          describeRepair(indexes) {
            const db = getNodeSqliteKysely<Record<string, Record<string, never>>>(
              check.database,
            ).withSchema("main");
            const counts = indexes.map((name) => {
              const row = executeSqliteQueryTakeFirstSync(
                check.database,
                db.selectFrom(name).select((eb) => eb.fn.countAll<number | bigint>().as("n")),
              );
              return `${name}=${String(row?.n)}`;
            });
            return `Rebuilt stale SQLite FTS indexes (agent ${context.databaseOptions.agentId}): ${counts.join(", ")}; SQLite ${captureSqliteNativeRuntimeAdmission()?.version}. No table rows were removed.`;
          },
        });
      }, state);
      requestSqliteWorkerOperationAdmission({
        stage: "prepare",
        facts: { kind: "agent-startup-fts", message: changes.join(" ") },
      });
      return true;
    },
    prepare() {
      return Promise.all([
        import("../config/sessions/session-accessor.sqlite-maintenance-transaction.js"),
        import("../config/sessions/session-accessor.sqlite-replacement-state.js"),
      ]).then(([metadata, replacement]) => {
        maintenance = metadata;
        replacements = replacement;
      });
    },
    cleanup(input: MetadataInput) {
      if (input.kind === "maintenance-plan") {
        releasePreparation();
      }
    },
    getPreparationReleases() {
      return preparation ? [releasePreparation] : [];
    },
  };
}
