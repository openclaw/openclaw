import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import { isSessionStateUpstreamCurrentInDatabase } from "./session-state-events.kernel.js";
import {
  deleteSessionUpstreamLinkInDatabase,
  listWatchedSessionUpstreamLinksInDatabase,
  readSessionUpstreamLinkInDatabase,
  sessionUpstreamLinkSourceMatches,
  upsertSessionUpstreamLinkInDatabase,
} from "./session-upstream-links.kernel.js";
import type { SessionUpstreamWorkerOperations } from "./session-upstream-links.worker-contract.js";

export const sessionUpstreamOperations = {
  "sessionUpstream.listWatched": (_input: undefined, context) =>
    listWatchedSessionUpstreamLinksInDatabase(context.open().db),
  "sessionUpstream.upsert": (
    input: SessionUpstreamWorkerOperations["sessionUpstream.upsert"]["input"],
    context,
  ) =>
    context.write(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const { source } = input;
      if (
        source &&
        !sessionUpstreamLinkSourceMatches(
          readSessionUpstreamLinkInDatabase(db, source.sessionKey, source.agentId),
          source,
        )
      ) {
        throw new Error("Session upstream source changed during initialization");
      }
      return upsertSessionUpstreamLinkInDatabase(db, input.link, input.now, input.ifAbsent);
    }),
  "sessionUpstream.delete": (
    input: SessionUpstreamWorkerOperations["sessionUpstream.delete"]["input"],
    context,
  ) =>
    context.write(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      return deleteSessionUpstreamLinkInDatabase(
        db,
        input.sessionKey,
        input.agentId,
        input.expected,
      );
    }),
  "sessionUpstream.settle": (
    {
      expected,
      settlement,
      sessionEntryCurrentSource,
    }: SessionUpstreamWorkerOperations["sessionUpstream.settle"]["input"],
    context,
  ) =>
    context.write(({ db }) => {
      requestSessionEntryCurrentAdmission(sessionEntryCurrentSource, {
        stage: "transaction",
        facts: undefined,
      });
      if (!isSessionStateUpstreamCurrentInDatabase(db, expected)) {
        return false;
      }
      const query = getNodeSqliteKysely<Pick<DB, "session_upstream_links">>(db);
      if (settlement.kind === "missing") {
        executeSqliteQuerySync(
          db,
          query
            .deleteFrom("session_upstream_links")
            .where("session_key", "=", expected.sessionKey)
            .where("agent_id", "=", expected.agentId),
        );
      } else {
        executeSqliteQuerySync(
          db,
          query
            .updateTable("session_upstream_links")
            .set({
              last_marker_json: JSON.stringify(settlement.marker),
              last_scanned_at: settlement.now,
              updated_at: settlement.now,
            })
            .where("session_key", "=", expected.sessionKey)
            .where("agent_id", "=", expected.agentId),
        );
      }
      return true;
    }),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
