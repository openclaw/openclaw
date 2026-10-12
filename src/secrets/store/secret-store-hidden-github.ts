import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { SecretStoreValidationError } from "./secret-store-validation-error.js";
import { assertSecretStoreValueLength } from "./secret-store-value.js";

type HiddenGitHubStoreKind = "device" | "oauth";
type HiddenGitHubStoreNameKind = "setup" | HiddenGitHubStoreKind;
export type HiddenGitHubStorePrefix = "github-device" | "github-oauth";

export const GITHUB_SETUP_HANDOFF_MAX_AGE_MS = 10 * 60_000;
export const GITHUB_DEVICE_STORE_MAX_AGE_MS = 15 * 60_000;
const HIDDEN_GITHUB_STORE_NAME_PATTERN = /^github-(setup|device|oauth)-[a-f0-9]{32}$/u;

export function classifyHiddenGitHubStoreName(name: string): HiddenGitHubStoreNameKind | undefined {
  const kind = HIDDEN_GITHUB_STORE_NAME_PATTERN.exec(name)?.[1];
  return kind === "setup" || kind === "device" || kind === "oauth" ? kind : undefined;
}

export function assertHiddenGitHubSecretRecordName(name: string): HiddenGitHubStoreKind {
  const kind = classifyHiddenGitHubStoreName(name);
  if (kind !== "device" && kind !== "oauth") {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      "Hidden GitHub secret record name must match github-device-<32 lowercase hex characters> or github-oauth-<32 lowercase hex characters>.",
    );
  }
  return kind;
}

export function hiddenGitHubStoreKindFromPrefix(
  prefix: HiddenGitHubStorePrefix,
): HiddenGitHubStoreKind {
  if (prefix === "github-device") {
    return "device";
  }
  if (prefix === "github-oauth") {
    return "oauth";
  }
  throw new SecretStoreValidationError(
    "SECRET_STORE_INVALID_NAME",
    'Hidden GitHub secret record prefix must be "github-device" or "github-oauth".',
  );
}

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
