import { realpath } from "node:fs/promises";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { digestClawValue } from "../claws/digest.js";
import { withAuthoredAgentRoster } from "../claws/migrate-validation.js";
import {
  applyClawMigrationPlan,
  buildClawMigrationPlan,
  ClawMigrationError,
  CLAW_MIGRATION_PLAN_SCHEMA_VERSION,
} from "../claws/migrate.js";
import { CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { withConfigSourceLocks } from "../config/write-lock.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { emitClawFailure, logClawExperimentalWarning } from "./claws-cli-output.js";
import type { ClawsMigrateOptions } from "./claws-cli.js";

async function readMigrationConfig() {
  const snapshot = await readConfigFileSnapshot({ observe: false, isolateEnv: true });
  if (!snapshot.exists || !snapshot.valid) {
    throw new ClawMigrationError(
      "migration_config_unavailable",
      "Migration requires an existing valid local configuration. Repair the config before retrying.",
    );
  }
  return {
    config: withAuthoredAgentRoster(snapshot.runtimeConfig, snapshot.sourceConfigBeforeMigrations),
    sources: [
      ...new Set([snapshot.path, await realpath(snapshot.path), ...(snapshot.includedPaths ?? [])]),
    ].toSorted(),
  };
}

function logMigrationPlan(
  plan: Awaited<ReturnType<typeof buildClawMigrationPlan>>["plan"],
  runtime: RuntimeEnv,
): void {
  logClawExperimentalWarning(runtime);
  runtime.log(`Existing agent: ${plan.agentId}`);
  runtime.log(`Workspace: ${plan.workspace}`);
  runtime.log(`Local Claw package: ${plan.packageRoot}`);
  runtime.log(`Portable identity: ${JSON.stringify(plan.agent)}`);
  if (plan.openClawProfile) {
    runtime.log(`OpenClaw profile: ${JSON.stringify(plan.openClawProfile.agent)}`);
  }
  runtime.log("Generated local Claw package files:");
  for (const file of plan.generatedPackageFiles) {
    runtime.log(`  ${file.path} (${file.byteLength} bytes, ${file.digest})`);
  }
  if (plan.workspaceFiles.length === 0) {
    runtime.log("Existing prompt files becoming Claw-managed: none");
  } else {
    runtime.log("Existing prompt files becoming Claw-managed (contents will not be rewritten):");
    for (const file of plan.workspaceFiles) {
      runtime.log(`  ${file.path} (${file.byteLength} bytes, ${file.digest})`);
    }
  }
  runtime.log("Retained outside Claw ownership:");
  for (const item of plan.retained) {
    runtime.log(`  ${item}`);
  }
  runtime.log(`Plan integrity: ${plan.planIntegrity}`);
}

function emitMigrationFailure(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  code: string,
  message: string,
  path = "$",
): void {
  emitClawFailure(runtime, json, message, {
    schemaVersion: CLAW_MIGRATION_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    ok: false,
    mutationAllowed: false,
    error: { code, message },
    blockers: [{ code, path, message }],
  });
}

export async function runClawsMigrateCommand(
  agentId: string,
  opts: ClawsMigrateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (!opts.dryRun && opts.yes && !opts.planIntegrity) {
    emitMigrationFailure(
      runtime,
      opts.json,
      "plan_integrity_required",
      "Automated Claw migration requires --yes with --plan-integrity from the exact dry-run plan.",
    );
    return;
  }
  if (!opts.dryRun && !opts.yes && opts.json) {
    emitMigrationFailure(
      runtime,
      true,
      "consent_required",
      "JSON migration requires --dry-run or --yes with --plan-integrity; interactive consent is available in human-readable mode.",
    );
    return;
  }

  let migration: Awaited<ReturnType<typeof buildClawMigrationPlan>>;
  let previewConfig: Awaited<ReturnType<typeof readMigrationConfig>>;
  try {
    previewConfig = await readMigrationConfig();
    migration = await buildClawMigrationPlan({
      agentId,
      config: previewConfig.config,
      options: { env: process.env },
    });
  } catch (error) {
    const code = error instanceof ClawMigrationError ? error.code : "migration_plan_failed";
    const message = error instanceof Error ? error.message : String(error);
    const path = error instanceof ClawMigrationError ? error.path : "$";
    emitMigrationFailure(runtime, opts.json, code, message, path);
    return;
  }

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, migration.plan);
    } else {
      logMigrationPlan(migration.plan, runtime);
    }
    return;
  }

  if (opts.yes && opts.planIntegrity !== migration.plan.planIntegrity) {
    emitMigrationFailure(
      runtime,
      opts.json,
      "plan_integrity_mismatch",
      "Consent does not match the current migration plan. Run claws migrate with --dry-run and use its exact plan-integrity value.",
    );
    return;
  }

  if (!opts.yes) {
    logMigrationPlan(migration.plan, runtime);
    const { confirm, isCancel } = await import("@clack/prompts");
    const confirmed = await confirm({
      message: `Enroll existing agent ${JSON.stringify(agentId)} as a Claw?`,
      initialValue: false,
    });
    if (isCancel(confirmed) || !confirmed) {
      runtime.log("Migration cancelled; no Claw ownership was recorded.");
      return;
    }
  }

  try {
    const result = await withAgentDeletion(
      agentId,
      async () =>
        await withConfigSourceLocks(
          previewConfig.sources,
          async (assertCurrent) => {
            const changed = () =>
              new ClawMigrationError(
                "migration_changed",
                "The agent, workspace files, or ownership changed after consent. Review a fresh dry-run plan before retrying.",
              );
            const latest = await readMigrationConfig();
            assertCurrent();
            if (digestClawValue(latest.sources) !== digestClawValue(previewConfig.sources)) {
              throw changed();
            }
            const current = await buildClawMigrationPlan({
              agentId,
              config: latest.config,
              options: { env: process.env },
            });
            if (current.plan.planIntegrity !== migration.plan.planIntegrity) {
              throw changed();
            }
            const expectedConfig = digestClawValue(latest);
            return await applyClawMigrationPlan({
              migration: current,
              config: latest.config,
              options: { env: process.env },
              assertCurrentConfig: async () => {
                assertCurrent();
                const live = await readMigrationConfig();
                assertCurrent();
                if (digestClawValue(live) !== expectedConfig) {
                  throw changed();
                }
              },
            });
          },
          process.env,
        ),
      { env: process.env },
    );
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Migrated agent: ${result.agentId}`);
    runtime.log(`Workspace: ${result.workspace}`);
    runtime.log(`Local Claw package: ${result.packageRoot}`);
    runtime.log(`Plan integrity: ${result.planIntegrity}`);
  } catch (error) {
    const code = error instanceof ClawMigrationError ? error.code : "migration_failed";
    const message = error instanceof Error ? error.message : String(error);
    const path = error instanceof ClawMigrationError ? error.path : "$";
    emitMigrationFailure(runtime, opts.json, code, message, path);
  }
}
