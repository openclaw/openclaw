import { assertSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentSource,
} from "../config/sessions/session-entry-current.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import type {
  GitHubSessionReceiptGeneration,
  GitHubSessionReceiptIdentities,
} from "./github-publication-read.types.js";
import {
  deferGitHubPublicationDeletionReceipt,
  withGitHubPublicationDeletionReceipt,
} from "./github-publication-receipts.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

/** Capture historical receipts while the session still owns its logical keys. */
export async function preparePersonalGitHubSessionReceiptDeletion(params: {
  agentId: string;
  generations: readonly GitHubSessionReceiptGeneration[];
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<
  (options?: {
    assertCurrent?: () => void;
    sessionEntryCurrent?: SessionEntryCurrentCheck;
    retainedSessionKeys?: ReadonlySet<string>;
  }) => Promise<void>
> {
  params.assertCurrent?.();
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  const generations = params.generations.map((generation) => ({ ...generation }));
  const input = {
    agentId: params.agentId,
    sessionKeys: [...new Set(generations.map((generation) => generation.sessionKey))],
  };
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  const receipts = (await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "githubPublication.prepareSessionReceiptDeletion", input }),
    { assertCurrent: params.assertCurrent, existingOnly: true },
  )) ?? { personal: [], repository: [] };
  params.assertCurrent?.();
  return async ({ assertCurrent, sessionEntryCurrent, retainedSessionKeys } = {}) => {
    const selectedKeys = new Set(input.sessionKeys.filter((key) => !retainedSessionKeys?.has(key)));
    if (selectedKeys.size === 0) {
      return;
    }
    const assertAdmission = () => {
      context.admission.assertCurrent();
      assertCurrent?.();
    };
    await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "githubPublication.deleteSessionReceipts",
          input: {
            agentId: input.agentId,
            sessionKeys: [...selectedKeys],
            generations: generations.filter((generation) =>
              selectedKeys.has(generation.sessionKey),
            ),
            receipts: {
              personal: receipts.personal.filter((receipt) =>
                selectedKeys.has(receipt.session_key),
              ),
              repository: receipts.repository.filter((receipt) =>
                selectedKeys.has(receipt.session_key),
              ),
            },
            sessionEntryCurrentSource: sessionEntryCurrent?.source,
          },
        }),
      {
        assertCurrent: assertAdmission,
        createAdmission: withGitHubPublicationDeletionReceipt(
          createSqliteWorkerWriteAdmission(
            (request) => {
              assertAdmission();
              assertSessionEntryCurrentAdmission(request, sessionEntryCurrent);
            },
            [context.admission.databasePath],
          ),
          context,
        ),
      },
    );
  };
}

export function readSessionReceiptDeletionIdentitiesInDatabase(
  database: OpenClawStateDatabase,
  params: { agentId: string; sessionKeys: readonly string[] },
): GitHubSessionReceiptIdentities {
  const read = (
    table: "github_personal_publication_requests" | "github_repository_publication_requests",
  ) =>
    params.sessionKeys.length && tableExists(database.db, table)
      ? executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<DB>(database.db)
            .selectFrom(table)
            .select(["request_id", "session_id", "session_key", "created_at_ms"])
            .where("agent_id", "=", params.agentId)
            .where("session_key", "in", sqliteStringSet(params.sessionKeys)),
        ).rows
      : [];
  return {
    personal: read("github_personal_publication_requests"),
    repository: read("github_repository_publication_requests"),
  };
}

/** Exact historical receipts and late inserts for the removed generation share one SQL edge. */
export function deletePersonalGitHubSessionReceiptsInDatabase(
  database: OpenClawStateDatabase,
  params: {
    agentId: string;
    sessionKeys: readonly string[];
    generations: readonly GitHubSessionReceiptGeneration[];
    receipts: GitHubSessionReceiptIdentities;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  },
): void {
  const tables = [
    "github_personal_publication_requests",
    "github_repository_publication_requests",
  ] as const;
  const existing = tables.filter((table) => tableExists(database.db, table));
  if (existing.length === 0 || params.sessionKeys.length === 0) {
    return;
  }
  // Repeated key/id pairs retain the first captured lifecycle revision.
  const generations = new Map(
    params.generations
      .toReversed()
      .map((generation) => [
        JSON.stringify([generation.sessionKey, generation.sessionId]),
        generation,
      ]),
  );
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSessionEntryCurrentAdmission(
        params.sessionEntryCurrentSource,
        { stage: "transaction", facts: undefined },
        { lookup: "logical" },
      );
      const query = getNodeSqliteKysely<DB>(db);
      const tombstones = new Map<string, { kind: "absent" }>();
      const hasLifecycles = tableExists(db, "github_publication_session_lifecycles");
      const current = readSessionReceiptDeletionIdentitiesInDatabase(database, params);
      for (const table of existing) {
        const historical =
          table === "github_personal_publication_requests"
            ? params.receipts.personal
            : params.receipts.repository;
        const captured = new Map(historical.map((receipt) => [receipt.request_id, receipt]));
        const selected = (
          table === "github_personal_publication_requests" ? current.personal : current.repository
        )
          .filter((receipt) => {
            const previous = captured.get(receipt.request_id);
            if (
              previous &&
              previous.session_id === receipt.session_id &&
              previous.session_key === receipt.session_key &&
              previous.created_at_ms === receipt.created_at_ms
            ) {
              return true;
            }
            const generation = generations.get(
              JSON.stringify([receipt.session_key, receipt.session_id]),
            );
            if (!generation) {
              return false;
            }
            // A missing personal sidecar is unproven, unlike an explicit absent revision.
            const binding =
              table === "github_personal_publication_requests"
                ? hasLifecycles
                  ? executeSqliteQueryTakeFirstSync(
                      db,
                      query
                        .selectFrom("github_publication_session_lifecycles")
                        .select("lifecycle_revision")
                        .where("publication_kind", "=", "personal")
                        .where("request_id", "=", receipt.request_id),
                    )
                  : undefined
                : executeSqliteQueryTakeFirstSync(
                    db,
                    query
                      .selectFrom("github_repository_publication_requests")
                      .select("session_lifecycle_revision as lifecycle_revision")
                      .where("request_id", "=", receipt.request_id),
                  );
            return (
              binding !== undefined && binding.lifecycle_revision === generation.lifecycleRevision
            );
          })
          .map((receipt) => receipt.request_id);
        if (selected.length === 0) {
          continue;
        }
        // Materialize before deleting sidecars: late personal receipts are selected through them.
        if (table === "github_personal_publication_requests" && hasLifecycles) {
          for (const requestId of selected) {
            const deleted = executeSqliteQuerySync(
              db,
              query
                .deleteFrom("github_publication_session_lifecycles")
                .where("publication_kind", "=", "personal")
                .where("request_id", "=", requestId)
                .returning("request_id"),
            ).rows;
            for (const row of deleted) {
              tombstones.set(JSON.stringify(["personal-lifecycle", row.request_id]), {
                kind: "absent",
              });
            }
          }
        }
        for (const requestId of selected) {
          const deleted = executeSqliteQuerySync(
            db,
            query.deleteFrom(table).where("request_id", "=", requestId).returning("request_id"),
          ).rows;
          for (const row of deleted) {
            tombstones.set(
              JSON.stringify([
                table === "github_personal_publication_requests" ? "personal" : "repository",
                row.request_id,
              ]),
              { kind: "absent" },
            );
          }
        }
      }
      requestSessionEntryCurrentAdmission(
        params.sessionEntryCurrentSource,
        { stage: "commit", facts: undefined },
        { lookup: "logical" },
      );
      deferGitHubPublicationDeletionReceipt(db, tombstones);
    },
    { database },
    { operationLabel: "github-personal-publication.session-delete" },
  );
}
