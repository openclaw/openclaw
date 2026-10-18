import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import {
  classifyHiddenGitHubStoreName,
  GITHUB_SETUP_HANDOFF_MAX_AGE_MS,
} from "./secret-store-github-names.js";
import type { HiddenGitHubStorePrefix } from "./secret-store-github-names.js";
import {
  writeHiddenGitHubSecretInDatabase,
  readHiddenGitHubSecretInDatabase,
  listHiddenGitHubSecretsInDatabase,
  deleteHiddenGitHubSecretInDatabase,
} from "./secret-store-hidden-github.kernel.js";
import { withMissingSecretStoreFallback } from "./secret-store-sqlite.js";

export const githubSetupOperations = {
  "githubSecrets.read": (
    { name, now }: { name: string; now: number },
    { open }: WorkerWriteOperationContext,
  ) => readHiddenGitHubSecretInDatabase(open().db, name, now),
  "githubSecrets.list": (
    { prefix, now }: { prefix: HiddenGitHubStorePrefix; now: number },
    { open }: WorkerWriteOperationContext,
  ) => listHiddenGitHubSecretsInDatabase(open().db, prefix, now),
  "githubSecrets.write": (
    input: { name: string; value: string; updatedBy?: string | null; now: number },
    { write }: WorkerWriteOperationContext,
  ) =>
    write(({ db }) => writeHiddenGitHubSecretInDatabase(db, input), {
      operationLabel: "secrets.store.write",
    }),
  "githubSecrets.delete": ({ name }: { name: string }, { write }: WorkerWriteOperationContext) =>
    write(({ db }) => deleteHiddenGitHubSecretInDatabase(db, name), {
      operationLabel: "secrets.store.delete-hidden-github",
    }),
  "githubSetup.consume": (
    { name, now }: { name: string; now: number },
    context: WorkerWriteOperationContext,
  ): string | undefined => {
    if (classifyHiddenGitHubStoreName(name) !== "setup") {
      return undefined;
    }
    return withMissingSecretStoreFallback(
      () =>
        context.write(
          ({ db }) => {
            const row = executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
                .deleteFrom("secret_store_entries")
                .where("scope_kind", "=", "team")
                .where("scope_id", "=", "")
                .where("name", "=", name)
                .where("kind", "=", "secret")
                .where("allowed_hosts", "is", null)
                .where("created_at_ms", ">=", now - GITHUB_SETUP_HANDOFF_MAX_AGE_MS)
                .where("created_at_ms", "<=", now)
                .where("deleted_at_ms", "is", null)
                .returning("value"),
            );
            return row?.value;
          },
          { operationLabel: "secrets.store.consume-github-setup-handoff" },
        ),
      undefined,
    );
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type GitHubSetupWorkerOperations = WorkerOperations<typeof githubSetupOperations>;
