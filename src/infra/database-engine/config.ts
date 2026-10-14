import type { OpenClawConfig } from "../../config/types.js";
import { resolveCanonicalConfiguredSecretInputString as resolveConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";
import type { DatabaseEngineInput } from "./types.js";
export type { DatabaseEngineInput } from "./types.js";

/** Resolve on the host; the existing broker input transport keeps credentials out of config/logs. */
export async function resolveDatabaseEngineInput(
  config: OpenClawConfig,
): Promise<DatabaseEngineInput> {
  if (config.database?.engine !== "postgres") {
    return undefined;
  }
  const { value, unresolvedRefReason } = await resolveConfiguredSecretInputString({
    config,
    env: process.env,
    value: config.database.postgres?.connection,
    path: "database.postgres.connection",
  });
  if (!value) {
    throw new Error(
      `${unresolvedRefReason ?? "database.engine postgres requires database.postgres.connection."} Configure a resolvable PostgreSQL DSN (prefer a SecretRef).`,
    );
  }
  return { connection: value, schemaPrefix: config.database.postgres?.schemaPrefix ?? "openclaw" };
}
