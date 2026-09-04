import fs from "node:fs";
import path from "node:path";
import {
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
} from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  preflightOpenClawDatabaseSchemas,
  type IncompatibleOpenClawDatabase,
  type IndeterminateOpenClawDatabase,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";

export type TargetDatabaseSchemaContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export function formatSchemaRefusalLines(
  schemas: {
    incompatible: readonly IncompatibleOpenClawDatabase[];
    indeterminate: readonly IndeterminateOpenClawDatabase[];
  },
  dryRun = false,
): string[] {
  const prefix = dryRun ? "Would refuse update" : "Update refused";
  return [
    ...schemas.incompatible.map((database) => {
      const agent = database.agentId ? ` (agent ${database.agentId})` : "";
      return `${prefix}: ${database.kind} database${agent} ${database.path} has schema ${database.foundVersion}; target supports ${database.supportedVersion}; writer build ${database.writerAppVersion ?? "unknown"}.`;
    }),
    ...schemas.indeterminate.map(
      (database) =>
        `${prefix}: could not inspect ${database.kind} database ${database.path}: ${database.reason}; retry once the gateway releases it.`,
    ),
    OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  ];
}

function checkTargetDatabaseSchemas(
  supportedVersions: OpenClawSchemaVersions | undefined,
  context: TargetDatabaseSchemaContext,
): OpenClawDatabaseSchemaPreflight {
  return supportedVersions
    ? preflightOpenClawDatabaseSchemas({
        env: context.env,
        supportedVersions,
        configuredAgentDatabaseTargets: (registeredDatabases) =>
          resolveConfiguredAgentDatabaseTargets(context.config, {
            env: context.env,
            registeredDatabases,
          }),
        configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(
          context.config,
          { env: context.env },
        ),
      })
    : { incompatible: [], indeterminate: [] };
}

function canonicalDatabaseIdentity(database: { kind: "agent" | "state"; path: string }): string {
  const resolved = path.resolve(database.path);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  const comparable = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  // State and agent schemas have independent version contracts even if a bad
  // configuration aliases both roles onto one file.
  return `${database.kind}\0${comparable}`;
}

/** Union caller and managed-service stores without reporting filesystem aliases twice. */
export function checkTargetDatabaseSchemasForContexts(
  supportedVersions: OpenClawSchemaVersions | undefined,
  contexts: readonly TargetDatabaseSchemaContext[],
): OpenClawDatabaseSchemaPreflight {
  if (!supportedVersions) {
    return { incompatible: [], indeterminate: [] };
  }
  const incompatible = new Map<string, IncompatibleOpenClawDatabase>();
  const indeterminate = new Map<string, IndeterminateOpenClawDatabase>();
  for (const context of contexts) {
    const result = checkTargetDatabaseSchemas(supportedVersions, context);
    for (const database of result.incompatible) {
      const identity = canonicalDatabaseIdentity(database);
      incompatible.set(identity, incompatible.get(identity) ?? database);
      indeterminate.delete(identity);
    }
    for (const database of result.indeterminate) {
      const identity = canonicalDatabaseIdentity(database);
      if (!incompatible.has(identity) && !indeterminate.has(identity)) {
        indeterminate.set(identity, database);
      }
    }
  }
  return { incompatible: [...incompatible.values()], indeterminate: [...indeterminate.values()] };
}

export function hasSchemaRefusal(schemas: OpenClawDatabaseSchemaPreflight): boolean {
  return schemas.incompatible.length > 0 || schemas.indeterminate.length > 0;
}
