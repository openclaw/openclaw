import { createConfigRuntimeEnv } from "../../config/config-env-vars.js";
import { resolveConfigSecretRef } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveCanonicalConfiguredSecretInputString as resolveConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";
import type { DatabaseEngineInput } from "./types.js";
export type { DatabaseEngineInput } from "./types.js";

/** Resolve on the host; the existing broker input transport keeps credentials out of config/logs. */
export async function resolveDatabaseEngineInput(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseEngineInput> {
  if (config.database?.engine !== "postgres") {
    return undefined;
  }
  const connection = config.database.postgres?.connection;
  const ref = resolveConfigSecretRef({
    config,
    path: "database.postgres.connection",
    value: connection,
    defaults: config.secrets?.defaults,
  });
  if (ref?.source === "store") {
    throw new Error(
      "PostgreSQL bootstrap cannot use a store-backed SecretRef; use env, file or exec.",
    );
  }
  const { value, unresolvedRefReason } = await resolveConfiguredSecretInputString({
    config,
    env: createConfigRuntimeEnv(config, env),
    value: connection,
    path: "database.postgres.connection",
  });
  if (!value) {
    throw new Error(
      `${unresolvedRefReason ?? "database.engine postgres requires database.postgres.connection."} Configure a resolvable PostgreSQL DSN (prefer a SecretRef).`,
    );
  }
  return Object.freeze({
    connection: value,
    schemaPrefix: config.database.postgres?.schemaPrefix ?? "openclaw",
  });
}
