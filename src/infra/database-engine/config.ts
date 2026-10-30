import { createConfigRuntimeEnv } from "../../config/config-env-vars.js";
import { resolveConfigSecretRef } from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveCanonicalConfiguredSecretInputString as resolveConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";
import type { DatabaseEngineInput, DatabaseEngineSelection } from "./types.js";
export type { DatabaseEngineInput } from "./types.js";

/** External stores follow the default engine, independent of built-in family overrides. */
export async function resolveDatabaseEngineInput(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseEngineInput> {
  return config.database?.engine === "postgres"
    ? resolveDatabasePostgresInput(config, env)
    : undefined;
}

export async function resolveDatabaseEngineSelection(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseEngineSelection> {
  const effectiveEngines = Object.freeze(resolveDatabaseFamilyEngines(config));
  if (!Object.values(effectiveEngines).includes("postgres")) {
    return Object.freeze({ effectiveEngines });
  }
  return Object.freeze({
    effectiveEngines,
    postgres: await resolveDatabasePostgresInput(config, env),
  });
}

/** Resolve on the host; the existing broker transport carries the captured connection. */
async function resolveDatabasePostgresInput(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<Exclude<DatabaseEngineInput, undefined>> {
  const connection = config.database?.postgres?.connection;
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
      `${unresolvedRefReason ?? "A postgres database family requires database.postgres.connection."} Configure a resolvable PostgreSQL DSN (prefer a SecretRef).`,
    );
  }
  return Object.freeze({
    connection: value,
    schemaPrefix: config.database?.postgres?.schemaPrefix ?? "openclaw",
  });
}
