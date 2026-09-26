import { threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import type { ReclamationDatabaseOptions } from "../config/sessions/session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseOperations } from "./openclaw-agent-execution-contract.js";

type MaintenanceCommand = SqliteWorkerCommand<
  Pick<
    AgentDatabaseOperations,
    "session.maintenance.prepare" | "session.maintenance.metadata" | "session.maintenance.release"
  >
>;

/** Metadata preparation and commit share the canonical actor's retained snapshots. */
export function createAgentDatabaseMaintenanceOwner(context: {
  databaseOptions: ReclamationDatabaseOptions;
  assertFileIdentity(): void;
  openWriter(): OpenClawAgentDatabase;
  admit(stage: "transaction" | "commit", publication?: unknown): void;
}) {
  const preparations = new Map<
    string,
    {
      plan: AgentDatabaseOperations["session.maintenance.prepare"]["input"];
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

  return {
    prepare() {
      return Promise.all([
        import("../config/sessions/session-accessor.sqlite-maintenance-transaction.js"),
        import("../config/sessions/session-accessor.sqlite-replacement-state.js"),
      ]).then(([metadata, replacement]) => {
        maintenance = metadata;
        replacements = replacement;
      });
    },
    execute(command: MaintenanceCommand) {
      if (command.type === "session.maintenance.release") {
        releasePreparation(command.input.id);
        return;
      }
      if (command.type === "session.maintenance.prepare" && maintenance) {
        context.assertFileIdentity();
        if (preparations.has(command.input.id)) {
          throw new Error("Session maintenance preparation is already retained");
        }
        // The coalesced planner may overlap one revoked predecessor awaiting cleanup.
        if (preparations.size >= 2) {
          throw new Error("Session maintenance preparation capacity is occupied");
        }
        const prepared = maintenance.prepareSessionMaintenanceInWorker({
          kind: "maintenance-plan",
          input: command.input.input,
          databaseOptions: context.databaseOptions,
        });
        preparations.set(command.input.id, { plan: command.input, prepared });
        return;
      }
      if (command.type === "session.maintenance.metadata" && maintenance && replacements) {
        const opened = context.openWriter();
        const previous = new Map<string, SessionEntry>();
        const current = new Map<string, SessionEntry>();
        const preparePublication = replacements.prepareSessionEntryReplacementPublication;
        let publication: ReturnType<typeof preparePublication> | undefined;
        const preparation =
          command.input.kind === "maintenance-plan"
            ? expectDefined(
                preparations.get(command.input.preparationId),
                "Session maintenance preparation",
              )
            : undefined;
        const plan = preparation
          ? { kind: "maintenance-plan" as const, input: preparation.plan.input }
          : { kind: "maintenance-statistics" as const };
        const value = maintenance.runSessionMaintenanceMetadataInTransaction(
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
              publication = preparePublication({
                pendingArchiveRecovery: false,
                previous,
                current,
                maintenancePlans: [],
                membershipInvalidatedKeys: [],
              });
              deferSqliteWorkerCommitReceipt(database.db, publication);
              context.admit("commit", publication);
            },
          },
          preparation?.prepared,
        );
        return value.kind === "maintenance-preservation-required" ||
          value.kind === "maintenance-plan-stale"
          ? { kind: "not-committed", workerThreadId: threadId, value }
          : {
              kind: "committed",
              workerThreadId: threadId,
              value,
              publication: expectDefined(publication, "Session maintenance commit receipt"),
            };
      }
      throw new Error("Unknown agent database operation");
    },
    cleanup(command: SqliteWorkerCommand<AgentDatabaseOperations>) {
      if (
        command.type === "session.maintenance.metadata" &&
        command.input.kind === "maintenance-plan"
      ) {
        releasePreparation(command.input.preparationId);
      }
    },
    getPreparationReleases() {
      return [...preparations.keys()].map((id) => () => releasePreparation(id));
    },
  };
}
