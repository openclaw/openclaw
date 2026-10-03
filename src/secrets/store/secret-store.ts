import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isRedactedSecretValue } from "../../config/redact-sentinel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../../state/openclaw-state-worker-store.js";
import { sealSecretSentinel } from "../sentinel.js";
import { captureSecretStoreExpiryCutoffs } from "./secret-store-expiry.kernel.js";
import {
  classifyHiddenGitHubStoreName,
  GITHUB_SETUP_HANDOFF_MAX_AGE_MS,
} from "./secret-store-hidden-github.js";
import { isMissingSecretStoreTableError } from "./secret-store-sqlite.js";
import { SecretStoreValidationError } from "./secret-store-validation-error.js";
import {
  assertSecretStoreEnvName,
  assertSecretStoreValue,
  normalizeScope,
  normalizeSecretAllowedHosts,
  parseSecretAllowedHosts,
  type SecretStoreKind,
  type SecretStoreScope,
} from "./secret-store-validation.js";
import type { SecretStoreListInput, SecretStoreRow } from "./secret-store.types.js";

export {
  assertSecretStoreValue,
  normalizeSecretAllowedHosts,
  type SecretStoreKind,
  type SecretStoreScope,
} from "./secret-store-validation.js";
export {
  deleteSecretStoreEntry,
  writeSecretStoreEntry,
  writeSecretStoreEntries,
  writeSecretStoreEntryWithRollback,
  type SecretStoreBatchWriteParams,
  type SecretStoreWriteEntry,
  type SecretStoreWriteParams,
} from "./secret-store-mutations.js";

export {
  deleteHiddenGitHubSecretRecord,
  listHiddenGitHubSecretRecordNames,
  readHiddenGitHubSecretRecord,
  writeHiddenGitHubSecretRecord,
} from "./secret-store-hidden-github.js";
export {
  SECRET_STORE_ALLOWED_HOSTS_MAX,
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";

type SecretStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;

export type SecretStoreEntryMetadata = {
  name: string;
  kind: SecretStoreKind;
  scopeKind: "team" | "identity";
  scopeId: string;
  updatedAtMs: number;
  createdAtMs: number;
  updatedBy: string | null;
  allowedHosts?: string[];
  valuePreview?: string;
};

type SecretStoreEgressBinding = {
  name: string;
  sentinel: string;
  allowedHosts: string[];
};

export type SecretStoreExecEnvironment = {
  env?: Record<string, string>;
  secretSentinels?: Record<string, string>;
  secretEgressBindings?: SecretStoreEgressBinding[];
};

type SecretStoreReadError =
  | { code: "SECRET_STORE_NOT_FOUND"; message: string }
  | { code: "SECRET_STORE_INVALID_NAME"; message: string }
  | { code: "SECRET_STORE_UNAVAILABLE"; message: string; cause: unknown };

const log = createSubsystemLogger("secrets/store");

function toMetadata(row: SecretStoreRow): SecretStoreEntryMetadata {
  if (row.kind === "secret") {
    registerSecretValueForRedaction(row.value);
  }
  return {
    name: row.name,
    kind: row.kind as SecretStoreKind,
    scopeKind: row.scope_kind as "team" | "identity",
    scopeId: row.scope_id,
    updatedAtMs: normalizeSqliteNumber(row.updated_at_ms) ?? 0,
    createdAtMs: normalizeSqliteNumber(row.created_at_ms) ?? 0,
    updatedBy: row.updated_by,
    ...(row.kind === "secret" ? { allowedHosts: parseSecretAllowedHosts(row.allowed_hosts) } : {}),
    ...(row.kind === "env" ? { valuePreview: row.value } : {}),
  };
}

export async function listSecretStoreEntries(
  params: SecretStoreListInput & {
    database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
    assertCurrent?: () => void;
  },
): Promise<SecretStoreEntryMetadata[]> {
  const context = captureOpenClawStateReadWorkerContext(params.database);
  params.assertCurrent?.();
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    {
      type: "secrets.metadata",
      input: {
        scope: { ...params.scope },
        includeDeleted: params.includeDeleted,
        redactedOnly: params.redactedOnly,
      },
    },
    { context, current: true },
  );
  if (reply && (!reply.ok || reply.type !== "secrets.metadata")) {
    throw new Error("Unexpected secret store metadata result.");
  }
  // Returned values reach the host redaction owner before any caller can consume them.
  const entries = (reply?.rows ?? []).map(toMetadata);
  context.admission.assertCurrent();
  params.assertCurrent?.();
  return entries;
}

/** Atomically returns and hard-deletes one exact fresh, non-egress GitHub setup handoff. */
export function consumeGitHubSetupHandoff(params: {
  name: string;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): string | undefined {
  if (classifyHiddenGitHubStoreName(params.name) !== "setup") {
    return undefined;
  }
  const now = params.nowMs ?? Date.now();
  try {
    const value = runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const row = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select("value")
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("name", "=", params.name)
            .where("kind", "=", "secret")
            .where("allowed_hosts", "is", null)
            .where("created_at_ms", ">=", now - GITHUB_SETUP_HANDOFF_MAX_AGE_MS)
            .where("created_at_ms", "<=", now)
            .where("deleted_at_ms", "is", null),
        );
        if (!row) {
          return;
        }
        executeSqliteQuerySync(
          sqlite,
          db
            .deleteFrom("secret_store_entries")
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("name", "=", params.name),
        );
        return row.value;
      },
      params.database,
      { operationLabel: "secrets.store.consume-github-setup-handoff" },
    );
    if (value !== undefined) {
      registerSecretValueForRedaction(value);
    }
    return value;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Captures one coherent team-store snapshot for an agent run's exec environment. */
export async function readSecretStoreExecEnvironment(params: {
  includeSecretSentinels: boolean;
  excludeNames?: readonly string[];
  database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  context?: OpenClawStateWorkerContext;
}): Promise<SecretStoreExecEnvironment> {
  const context = params.context ?? captureOpenClawStateReadWorkerContext(params.database);
  const includeSecretSentinels = params.includeSecretSentinels;
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "secrets.execEnvironment", input: { excludeNames: params.excludeNames ?? [] } },
    { context, preferIndependentWarmRead: true },
  );
  if (reply && (!reply.ok || reply.type !== "secrets.execEnvironment")) {
    throw new Error("Unexpected secret store exec environment result.");
  }
  const rows = reply?.rows ?? [];
  // Worker isolates cannot register with the host's redaction or sentinel owners.
  for (const row of rows) {
    if (row.kind === "secret" && !isRedactedSecretValue(row.value)) {
      registerSecretValueForRedaction(row.value);
    }
  }
  context.admission.assertCurrent();
  const env: Record<string, string> = {};
  const secretSentinels: Record<string, string> = {};
  const secretEgressBindings: SecretStoreEgressBinding[] = [];
  for (const row of rows) {
    if (isRedactedSecretValue(row.value)) {
      log.warn(
        `Secret store entry "${row.name}" contains a redaction placeholder; excluded from the exec environment. Replace it with a real value, or run openclaw doctor --fix for a Gateway token.`,
      );
      continue;
    }
    if (row.kind === "env") {
      env[row.name] = row.value;
      continue;
    }
    if (includeSecretSentinels) {
      // Subprocesses never receive plaintext, even with provider-auth masking disabled.
      const sentinel = sealSecretSentinel(row.value, { label: `exec-store:${row.name}` });
      secretSentinels[row.name] = sentinel;
      secretEgressBindings.push({
        name: row.name,
        sentinel,
        allowedHosts: parseSecretAllowedHosts(row.allowed_hosts),
      });
    }
  }
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(secretSentinels).length > 0 ? { secretSentinels } : {}),
    ...(secretEgressBindings.length > 0 ? { secretEgressBindings } : {}),
  };
}

export async function readSecretStoreValue(params: {
  scope: SecretStoreScope;
  name: string;
  database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<Result<string, SecretStoreReadError>> {
  try {
    const name = params.name;
    assertSecretStoreEnvName(name);
    const context = params.context ?? captureOpenClawStateReadWorkerContext(params.database);
    params.assertCurrent?.();
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      { type: "secrets.value", input: { name } },
      { context, preferIndependentWarmRead: true },
    );
    if (reply && (!reply.ok || reply.type !== "secrets.value")) {
      throw new Error("Unexpected secret store value result.");
    }
    const row = reply?.row;
    if (row?.kind === "secret") {
      registerSecretValueForRedaction(row.value);
    }
    context.admission.assertCurrent();
    params.assertCurrent?.();
    if (!row) {
      return err({
        code: "SECRET_STORE_NOT_FOUND",
        message: `Secret store entry "${name}" was not found.`,
      });
    }
    return ok(row.value);
  } catch (error) {
    if (error instanceof SecretStoreValidationError) {
      return err({ code: "SECRET_STORE_INVALID_NAME", message: error.message });
    }
    return err({
      code: "SECRET_STORE_UNAVAILABLE",
      message: "Secret store database is unavailable.",
      cause: error,
    });
  }
}

/**
 * Saves a secret for one config key in a fresh team-store entry through the
 * state worker and returns the entry name. `assertCurrent` is the requester's
 * live authority; the worker checks it again at transaction and commit
 * admission, so a revoked request writes nothing.
 */
export async function writeSecretStoreEntryForConfigRef(params: {
  baseName: string;
  value: string;
  updatedBy: string;
  assertCurrent?: () => void;
  database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
}): Promise<string> {
  registerSecretValueForRedaction(params.value);
  assertSecretStoreValue(params.value, "secret", params.baseName);
  const context = captureOpenClawStateWorkerContext(params.database);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    params.assertCurrent?.();
  };
  const { name } = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "secrets.writeForConfigRef",
        input: {
          baseName: params.baseName,
          value: params.value,
          writer: params.updatedBy,
          now: Date.now(),
        },
      }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  return name;
}

export function updateSecretStoreAllowedHosts(params: {
  scope: SecretStoreScope;
  name: string;
  allowedHosts: readonly string[];
  updatedBy: string | null;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertSecretStoreEnvName(params.name);
  const allowedHosts = normalizeSecretAllowedHosts(params.allowedHosts);
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      const updated = executeSqliteQuerySync(
        sqlite,
        db
          .updateTable("secret_store_entries")
          .set({
            allowed_hosts: allowedHosts.length ? JSON.stringify(allowedHosts) : null,
            updated_at_ms: now,
            updated_by: params.updatedBy,
          })
          .where("scope_kind", "=", scopeKind)
          .where("scope_id", "=", scopeId)
          .where("name", "=", params.name)
          .where("kind", "=", "secret")
          .where("deleted_at_ms", "is", null),
      );
      if (Number(updated.numAffectedRows ?? 0n) !== 1) {
        throw new SecretStoreValidationError(
          "SECRET_STORE_INVALID_ALLOWED_HOST",
          `Secret store entry "${params.name}" is missing or is not a secret entry.`,
        );
      }
    },
    params.database,
    { operationLabel: "secrets.store.allowed-hosts" },
  );
}

export async function purgeExpiredSecretStoreEntries(
  params: { database?: Pick<OpenClawStateDatabaseOptions, "path" | "env"> } = {},
): Promise<number> {
  const input = captureSecretStoreExpiryCutoffs();
  const context = captureOpenClawStateWorkerContext(params.database);
  return await executeOpenClawStateWorker(context, { type: "secrets.purge", input });
}
