import { threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceLiveProtection,
} from "../config/sessions/session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

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

export type AgentDatabaseMaintenanceOperations = WorkerOperations<
  ReturnType<typeof createAgentDatabaseMaintenanceOwner>["operations"]
>;
