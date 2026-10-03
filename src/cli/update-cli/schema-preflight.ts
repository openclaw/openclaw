import { isDeepStrictEqual } from "node:util";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { cloneEnvWithPlatformSemantics } from "../../config/env-vars.js";
import { createConfigIO } from "../../config/io.js";
import { resolveConfigPath } from "../../config/paths.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { preflightOpenClawDatabaseSchemaContexts } from "../../state/openclaw-database-preflight-contexts.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  type IncompatibleOpenClawDatabase,
  type IndeterminateOpenClawDatabase,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { isArtifactPreservingStateRead } from "../../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { UpdatePreMutationError } from "./shared.js";
import { createUpdateConfigFailure } from "./update-command-config-failure.js";

type TargetDatabaseSchemaContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export type TargetDatabaseSchemaContextOptions = {
  legacyConfigPlan?: LegacyConfigUpdatePlan;
  /** Candidate admission owns schema validation; the installed process still pins source bytes. */
  configValidation?: "candidate";
};

/** Candidate admission sees only the invoking process's config and shared-state selectors. */
export function isCandidateAdmissionContextCovered(
  env: NodeJS.ProcessEnv,
  admissionEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    resolveConfigPath(env) === resolveConfigPath(admissionEnv) &&
    resolveOpenClawStateSqlitePath(env) === resolveOpenClawStateSqlitePath(admissionEnv)
  );
}

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
        `${prefix}: could not inspect ${database.kind} database ${database.path}: ${database.reason}; check database access and free disk space, then retry the update.`,
    ),
    OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  ];
}

export async function captureTargetDatabaseSchemaContext(
  env: NodeJS.ProcessEnv,
  options?: TargetDatabaseSchemaContextOptions,
) {
  const configValidation =
    options?.configValidation === "candidate" && isCandidateAdmissionContextCovered(env)
      ? ("candidate" as const)
      : undefined;
  // Discover stores without plugins, recovery, observations, or caller environment changes.
  const inspectionEnv = cloneEnvWithPlatformSemantics(env);
  const readEnv = cloneEnvWithPlatformSemantics(env);
  const { snapshot, writeOptions } = await createConfigIO({
    env: inspectionEnv,
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshotForWrite();
  // A Doctor-validated projection is usable only for its exact authored source.
  // Keep the original snapshot intact for checkpointing and later revalidation;
  // a caller's plan must not authorize a different managed service's config.
  const planned = options?.legacyConfigPlan;
  const before = planned?.snapshot;
  let legacyConfigPlan =
    before &&
    before.path === snapshot.path &&
    before.exists === snapshot.exists &&
    before.raw === snapshot.raw &&
    before.hash === snapshot.hash &&
    isDeepStrictEqual(before.includedPaths ?? [], snapshot.includedPaths ?? []) &&
    isDeepStrictEqual(before.includeProvenance ?? [], snapshot.includeProvenance ?? []) &&
    isDeepStrictEqual(before.sourceConfig, snapshot.sourceConfig) &&
    isDeepStrictEqual(
      planned.includeIdentity.includeFileHashesForWrite ?? {},
      writeOptions.includeFileHashesForWrite ?? {},
    ) &&
    isDeepStrictEqual(
      planned.includeIdentity.includeFileTargetsForWrite ?? {},
      writeOptions.includeFileTargetsForWrite ?? {},
    )
      ? planned
      : undefined;
  if (before?.path === snapshot.path && !legacyConfigPlan) {
    // This is read-only admission. A concurrent save needs a fresh projection,
    // never reuse of the old source's plan or refusal merely because it changed.
    if (!snapshot.valid) {
      const { planLegacyConfigForUpdateChannel } =
        await import("../../commands/doctor/legacy-config-repair.js");
      legacyConfigPlan = planLegacyConfigForUpdateChannel(snapshot, writeOptions);
    }
  }
  if (
    (!snapshot.valid && !legacyConfigPlan && configValidation !== "candidate") ||
    snapshot.readError
  ) {
    throw createUpdateConfigFailure(snapshot);
  }
  return {
    env: inspectionEnv,
    config:
      configValidation === "candidate"
        ? snapshot.sourceConfig
        : (legacyConfigPlan?.config ?? snapshot.sourceConfig ?? snapshot.config),
    configSnapshot: snapshot,
    readEnv,
    ...(legacyConfigPlan ? { legacyConfigPlan } : {}),
    ...(configValidation ? { configValidation } : {}),
  };
}

/** Inspect the union of caller/service stores without granting migration ownership. */
export async function checkTargetDatabaseSchemasForContexts(
  supportedVersions: OpenClawSchemaVersions | undefined,
  contexts: readonly TargetDatabaseSchemaContext[],
): Promise<OpenClawDatabaseSchemaPreflight> {
  if (!supportedVersions) {
    return { incompatible: [], indeterminate: [] };
  }
  const inspectionContexts = contexts.map((context) => {
    try {
      return {
        env: context.env,
        configuredAgentDatabaseCandidatePaths: resolveConfiguredAgentDatabaseCandidatePaths(
          context.config,
          { env: context.env },
        ),
      };
    } catch (error) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        `Update refused: could not inspect configured database paths: ${formatErrorMessage(error)}`,
      );
    }
  });
  return preflightOpenClawDatabaseSchemaContexts({
    contexts: inspectionContexts,
    supportedVersions,
    preserveSourceArtifacts: isArtifactPreservingStateRead(),
  });
}

export function hasSchemaRefusal(schemas: OpenClawDatabaseSchemaPreflight): boolean {
  return schemas.incompatible.length > 0 || schemas.indeterminate.length > 0;
}
