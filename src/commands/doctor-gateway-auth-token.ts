/** Resolves gateway service auth tokens without leaking exec-backed secrets during install. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef, type SecretRef } from "../config/types.secrets.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";

/** Preserve a recovered credential without overwriting any existing store entry. */
export async function preserveGatewayAuthTokenForService(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  token: string;
  assertCurrent?: () => void;
}): Promise<{ ref: SecretRef; reused: boolean; backupPath?: string }> {
  const { listSecretStoreEntries, readSecretStoreValue, writeSecretStoreEntryForConfigRef } =
    await import("../secrets/store/secret-store.js");
  const database = { env: params.env };
  const scope = { kind: "team" as const };
  const provider = resolveDefaultSecretProviderAlias(params.cfg, "store", {
    preferFirstProviderForSource: true,
  });
  for (const entry of await listSecretStoreEntries({
    scope,
    database,
    assertCurrent: params.assertCurrent,
  })) {
    const stored = readSecretStoreValue({ scope, database, name: entry.name });
    if (!stored.ok) {
      if (stored.error.code === "SECRET_STORE_NOT_FOUND") {
        continue;
      }
      throw new Error(stored.error.message);
    }
    if (stored.value === params.token) {
      return { ref: { source: "store", provider, id: entry.name }, reused: true };
    }
  }
  const { stat } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { resolveOpenClawStateSqlitePath } = await import("../state/openclaw-state-db.paths.js");
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  const existing = await stat(databasePath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  let backupPath: string | undefined;
  if (existing) {
    const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
    params.assertCurrent?.();
    ({ path: backupPath } = await createVerifiedSqliteSnapshot({
      sourcePath: databasePath,
      targetPath: `${databasePath}.doctor-gateway-token.${randomUUID()}.bak`,
      preserveRowIds: true,
    }));
  }
  const id = await writeSecretStoreEntryForConfigRef({
    baseName: "OPENCLAW_GATEWAY_TOKEN",
    value: params.token,
    updatedBy: "doctor",
    database,
    assertCurrent: params.assertCurrent,
  });
  return { ref: { source: "store", provider, id }, reused: false, backupPath };
}

/**
 * Resolves the token a managed gateway service can receive at install/update time.
 *
 * Exec SecretRefs are skipped by default because the service installer cannot safely evaluate
 * arbitrary commands. Configured SecretRefs never fall back to ambient credentials.
 */
export async function resolveGatewayAuthTokenForService(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: { allowExecSecretRefs?: boolean } = {},
): Promise<{ token?: string; unavailableReason?: string }> {
  const tokenRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  }).ref;
  if (tokenRef?.source === "exec" && options.allowExecSecretRefs !== true) {
    return {
      unavailableReason:
        "gateway.auth.token SecretRef is configured but unavailable because exec SecretRef resolution is disabled.",
    };
  }
  const resolved = await resolveGatewayAuthToken({
    cfg,
    env,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.token) {
    return { token: resolved.token };
  }
  if (!resolved.secretRefConfigured) {
    return {};
  }
  if (resolved.unresolvedRefReason?.includes("resolved to an empty value")) {
    return { unavailableReason: resolved.unresolvedRefReason };
  }
  return {
    unavailableReason: `gateway.auth.token SecretRef is configured but unresolved (${resolved.unresolvedRefReason ?? "unknown reason"}).`,
  };
}
