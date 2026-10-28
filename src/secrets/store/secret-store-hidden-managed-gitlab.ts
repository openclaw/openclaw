import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { observeSecretStoreMutation } from "./secret-store-changes.js";
import {
  assertHiddenGitLabSecretRecordName,
  hiddenGitLabStoreKindFromPrefix,
  type HiddenGitLabStorePrefix,
} from "./secret-store-managed-gitlab-names.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";

/** Writes one hidden GitLab authorization record through its shared-state owner. */
export async function writeHiddenGitLabSecretRecord(params: {
  name: string;
  value: string;
  expectedValue?: string;
  expectedAbsent?: boolean;
}): Promise<void> {
  assertHiddenGitLabSecretRecordName(params.name);
  assertSecretStoreValueLength(params.value, "secret");
  const context = captureOpenClawStateWorkerContext();
  await observeSecretStoreMutation(
    runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({
        type: "gitlabManagedSecrets.write",
        input: {
          name: params.name,
          value: params.value,
          expectedValue: params.expectedValue,
          expectedAbsent: params.expectedAbsent,
          now: Date.now(),
        },
      }),
    ),
    context.admission.databasePath,
    [params.name],
  );
  registerSecretValueForRedaction(params.value);
}

/** Reads one exact live hidden GitLab authorization record. */
export async function readHiddenGitLabSecretRecord(params: {
  name: string;
}): Promise<string | undefined> {
  assertHiddenGitLabSecretRecordName(params.name);
  const context = captureOpenClawStateReadWorkerContext();
  const value = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "gitlabManagedSecrets.read",
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
export async function listHiddenGitLabSecretRecords(params: {
  prefix?: HiddenGitLabStorePrefix;
}): Promise<Array<{ name: string; value: string }>> {
  if (params.prefix !== undefined) {
    hiddenGitLabStoreKindFromPrefix(params.prefix);
  }
  const context = captureOpenClawStateReadWorkerContext();
  const rows =
    (await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "gitlabManagedSecrets.list",
          input: { prefix: params.prefix, now: Date.now() },
        }),
      { existingOnly: true },
    )) ?? [];
  for (const row of rows) {
    registerSecretValueForRedaction(row.value);
  }
  return rows;
}

/** Hard-deletes one exact hidden GitLab authorization record. */
export async function deleteHiddenGitLabSecretRecord(params: { name: string }): Promise<void> {
  assertHiddenGitLabSecretRecordName(params.name);
  const context = captureOpenClawStateWorkerContext();
  await observeSecretStoreMutation(
    runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({
        type: "gitlabManagedSecrets.delete",
        input: { name: params.name },
      }),
    ),
    context.admission.databasePath,
    [params.name],
  );
}
