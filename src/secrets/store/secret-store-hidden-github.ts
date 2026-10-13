import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  assertHiddenGitHubSecretRecordName,
  hiddenGitHubStoreKindFromPrefix,
  type HiddenGitHubStorePrefix,
} from "./secret-store-github-names.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";

/** Writes one hidden GitHub authorization record through its shared-state owner. */
export async function writeHiddenGitHubSecretRecord(params: {
  name: string;
  value: string;
  updatedBy?: string | null;
  database?: OpenClawStateDatabaseOptions;
}): Promise<void> {
  assertHiddenGitHubSecretRecordName(params.name);
  assertSecretStoreValueLength(params.value, "secret");
  const context = captureOpenClawStateWorkerContext(params.database);
  await runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({
      type: "githubSecrets.write",
      input: {
        name: params.name,
        value: params.value,
        updatedBy: params.updatedBy,
        now: Date.now(),
      },
    }),
  );
  registerSecretValueForRedaction(params.value);
}

/** Reads one exact live hidden GitHub authorization record. */
export async function readHiddenGitHubSecretRecord(params: {
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): Promise<string | undefined> {
  assertHiddenGitHubSecretRecordName(params.name);
  const context = captureOpenClawStateReadWorkerContext(params.database);
  const value = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "githubSecrets.read",
        input: { name: params.name, now: Date.now() },
      }),
    { existingOnly: true },
  );
  if (value !== undefined) {
    registerSecretValueForRedaction(value);
  }
  return value;
}

/** Lists each live hidden authorization record in one owner snapshot. */
export async function listHiddenGitHubSecretRecords(params: {
  prefix: HiddenGitHubStorePrefix;
  database?: OpenClawStateDatabaseOptions;
}): Promise<Array<{ name: string; value: string }>> {
  hiddenGitHubStoreKindFromPrefix(params.prefix);
  const context = captureOpenClawStateReadWorkerContext(params.database);
  const rows =
    (await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "githubSecrets.list",
          input: { prefix: params.prefix, now: Date.now() },
        }),
      { existingOnly: true },
    )) ?? [];
  for (const row of rows) {
    registerSecretValueForRedaction(row.value);
  }
  return rows;
}

export async function listHiddenGitHubSecretRecordNames(params: {
  prefix: HiddenGitHubStorePrefix;
  database?: OpenClawStateDatabaseOptions;
}): Promise<string[]> {
  return (await listHiddenGitHubSecretRecords(params)).map(({ name }) => name);
}

/** Hard-deletes one exact hidden GitHub authorization record. */
export async function deleteHiddenGitHubSecretRecord(params: {
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): Promise<void> {
  assertHiddenGitHubSecretRecordName(params.name);
  const context = captureOpenClawStateWorkerContext(params.database);
  await runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({
      type: "githubSecrets.delete",
      input: { name: params.name },
    }),
  );
}
