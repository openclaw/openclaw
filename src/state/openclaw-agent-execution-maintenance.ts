import { threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceLiveProtection,
  SessionMaintenanceReadCommand,
} from "../config/sessions/session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

type PreparationInput = Omit<
  Extract<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>,
  "kind"
> & { id: string };
type MetadataInput =
  | Exclude<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>
  | {
      kind: "maintenance-plan";
      preparationId: string;
      protection: SessionMaintenanceLiveProtection;
    };

/** Metadata preparation and commit share the canonical actor's retained snapshots. */
export function createAgentDatabaseMaintenanceOwner(context: {
  databaseOptions: ReclamationDatabaseOptions;
  assertFileIdentity(): void;
  openWriter(): OpenClawAgentDatabase;
  readPreparedDatabase(): OpenClawAgentDatabase;
  admit(stage: "transaction" | "commit", publication?: unknown): void;
}) {
  const preparations = new Map<
    string,
    {
      plan: PreparationInput;
      prepared: ReturnType<
        typeof import("../config/sessions/session-accessor.sqlite-maintenance-transaction.js").prepareSessionMaintenanceInWorker
      >;
    }
  >();
  let maintenance:
    | typeof import("../config/sessions/session-accessor.sqlite-maintenance-transaction.js")
    | undefined;
  let replacements:
    | typeof import("../config/sessions/session-accessor.sqlite-replacement-state.js")
    | undefined;
  const releasePreparation = (id: string) => {
    const preparation = preparations.get(id);
    if (preparation) {
      preparation.prepared.release();
      preparations.delete(id);
    }
  };
  const operations = {
    "session.maintenance.read": (plan: SessionMaintenanceReadCommand) => {
      context.assertFileIdentity();
      const kernel = expectDefined(maintenance, "Session maintenance kernel");
      return {
        kind: "session-maintenance-read" as const,
        result: kernel.readSessionMaintenanceInWorker(
          { ...plan, databaseOptions: context.databaseOptions },
          context.readPreparedDatabase(),
        ),
        workerThreadId: threadId,
      };
    },
    "session.maintenance.release": ({ id }: { id: string }) => releasePreparation(id),
    "session.maintenance.prepare": (input: PreparationInput) => {
      const kernel = expectDefined(maintenance, "Session maintenance kernel");
      context.assertFileIdentity();
      if (preparations.has(input.id)) {
        throw new Error("Session maintenance preparation is already retained");
      }
      // The coalesced planner may overlap one revoked predecessor awaiting cleanup.
      if (preparations.size >= 2) {
        throw new Error("Session maintenance preparation capacity is occupied");
      }
      const prepared = kernel.prepareSessionMaintenanceInWorker({
        kind: "maintenance-plan",
        input: input.input,
        ageOwner: input.ageOwner,
        ageChanges: input.ageChanges,
        databaseOptions: context.databaseOptions,
      });
      preparations.set(input.id, { plan: input, prepared });
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
      const preparation =
        input.kind === "maintenance-plan"
          ? expectDefined(preparations.get(input.preparationId), "Session maintenance preparation")
          : undefined;
      if (preparation && input.kind === "maintenance-plan") {
        Object.assign(preparation.plan.input, input.protection);
      }
      const plan: SessionMaintenanceMetadataCommand =
        input.kind === "maintenance-plan"
          ? {
              ...expectDefined(preparation, "Session maintenance preparation").plan,
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
          beforeCommit(database) {
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
            deferSqliteWorkerCommitReceipt(database.db, publication);
            context.admit("commit", publication);
          },
        },
        preparation?.prepared,
      );
      return value.kind === "maintenance-preservation-required" ||
        value.kind === "maintenance-plan-stale"
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
        releasePreparation(input.preparationId);
      }
    },
    getPreparationReleases() {
      return [...preparations.keys()].map((id) => () => releasePreparation(id));
    },
  };
}

export type AgentDatabaseMaintenanceOperations = WorkerOperations<
  ReturnType<typeof createAgentDatabaseMaintenanceOwner>["operations"]
>;
