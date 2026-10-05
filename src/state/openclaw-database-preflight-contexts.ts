import fs from "node:fs";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import type {
  IncompatibleOpenClawDatabase,
  IndeterminateOpenClawDatabase,
  OpenClawDatabaseSchemaPreflight,
} from "./openclaw-database-preflight.types.js";
import type { OpenClawSchemaVersions } from "./openclaw-schema-versions.js";

function canonicalDatabaseIdentity(database: { kind: "agent" | "state"; path: string }): string {
  let canonical: string;
  try {
    // Native traversal must see link/../file before lexical normalization.
    canonical = fs.realpathSync.native(database.path);
  } catch {
    canonical = path.resolve(database.path);
  }
  const comparable = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return `${database.kind}\0${comparable}`;
}

/** Inspect one checkpoint's context union without granting migration ownership. */
export async function preflightOpenClawDatabaseSchemaContexts(options: {
  contexts: readonly {
    env: NodeJS.ProcessEnv;
    configuredAgentDatabaseCandidatePaths: readonly string[];
  }[];
  supportedVersions: OpenClawSchemaVersions;
  preserveSourceArtifacts: boolean;
}): Promise<OpenClawDatabaseSchemaPreflight> {
  const groups: {
    env: NodeJS.ProcessEnv;
    configuredAgentDatabaseCandidatePaths: string[];
  }[] = [];
  for (const context of options.contexts) {
    const stateDir = resolveStateDir(context.env);
    const previous = groups.at(-1);
    // Aliased roots can have different lexical imports boundaries. Adjacent
    // exact roots share discovery without reordering other profiles' refusals.
    if (previous?.env.OPENCLAW_STATE_DIR === stateDir) {
      previous.configuredAgentDatabaseCandidatePaths.push(
        ...context.configuredAgentDatabaseCandidatePaths,
      );
    } else {
      const env = cloneEnvWithPlatformSemantics(context.env);
      env.OPENCLAW_STATE_DIR = stateDir;
      groups.push({
        env,
        configuredAgentDatabaseCandidatePaths: [...context.configuredAgentDatabaseCandidatePaths],
      });
    }
  }
  const incompatible = new Map<string, IncompatibleOpenClawDatabase>();
  const indeterminate = new Map<string, IndeterminateOpenClawDatabase>();
  for (const group of groups) {
    const result = await preflightOpenClawDatabaseSchemas({
      env: group.env,
      supportedVersions: options.supportedVersions,
      preserveSourceArtifacts: options.preserveSourceArtifacts,
      configuredAgentDatabaseTargets: [],
      configuredAgentDatabaseCandidatePaths: [
        ...new Set(group.configuredAgentDatabaseCandidatePaths),
      ],
    });
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
