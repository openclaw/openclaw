import fs from "node:fs/promises";
import path from "node:path";
import { buildLegacyMigrationPreview } from "../channels/plugins/legacy-state-migration-preview.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isSqliteSnapshotFile } from "../infra/sqlite-file-header.js";
import type {
  PluginDoctorMigrationBackupResource,
  PluginDoctorStateMigration,
} from "../plugins/doctor-contract-module.js";

async function resourceKind(
  filename: string,
): Promise<PluginDoctorMigrationBackupResource["kind"]> {
  try {
    if ((await fs.stat(filename)).isDirectory()) {
      return "directory";
    }
    return (await isSqliteSnapshotFile(filename)) ? "sqlite" : "file";
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return filename.endsWith(".sqlite") ? "sqlite" : "file";
    }
    throw error;
  }
}

type PluginDoctorPlanResolver = (params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}) =>
  | ChannelLegacyStateMigrationPlan[]
  | Promise<ChannelLegacyStateMigrationPlan[] | null | undefined>
  | null
  | undefined;

/** Adapts legacy channel migration plans to the canonical plugin doctor contract. */
export function definePluginDoctorMigrationFromPlans(params: {
  id: string;
  label: string;
  doctorOnly?: boolean;
  resolvePlans: PluginDoctorPlanResolver;
}): PluginDoctorStateMigration {
  const resolvePlans = async (input: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
  }): Promise<ChannelLegacyStateMigrationPlan[]> => {
    const plans =
      (await params.resolvePlans({
        cfg: input.config,
        env: input.env,
        stateDir: input.stateDir,
        oauthDir: input.oauthDir,
      })) ?? [];
    const resolvedPlans: ChannelLegacyStateMigrationPlan[] = [];
    for (const plan of plans) {
      resolvedPlans.push(
        plan.kind === "plugin-state-import" && !plan.stateDir
          ? { ...plan, stateDir: input.stateDir }
          : plan,
      );
    }
    return resolvedPlans;
  };

  return {
    id: params.id,
    label: params.label,
    ...(params.doctorOnly === true ? { doctorOnly: true } : {}),
    async collectBackupResources(input) {
      const [{ resolveOAuthDir }, { resolveOpenClawStateSqlitePath }] = await Promise.all([
        import("../config/paths.js"),
        import("../state/openclaw-state-db.paths.js"),
      ]);
      const plans = await resolvePlans({
        ...input,
        oauthDir: resolveOAuthDir(input.env, input.stateDir),
      });
      const resources: PluginDoctorMigrationBackupResource[] = [];
      for (const plan of plans) {
        if (path.isAbsolute(plan.sourcePath)) {
          const kind = await resourceKind(plan.sourcePath);
          resources.push({ path: plan.sourcePath, kind });
          if (plan.kind !== "plugin-state-import") {
            resources.push({ path: plan.targetPath, kind });
          } else if (plan.cleanupSource === "rename") {
            resources.push({ path: `${plan.sourcePath}.migrated`, kind: "file" });
          }
        } else if (plan.kind !== "plugin-state-import" || !plan.removeSource) {
          throw new Error(`Migration source has no absolute data path: ${plan.sourcePath}`);
        }
        if (plan.kind === "plugin-state-import") {
          resources.push({
            path: resolveOpenClawStateSqlitePath({
              ...input.env,
              OPENCLAW_STATE_DIR: plan.stateDir ?? input.stateDir,
            }),
            kind: "sqlite",
          });
        }
      }
      return resources;
    },
    async detectLegacyState(input) {
      const plans = await resolvePlans(input);
      return plans.length > 0
        ? { preview: plans.map((plan) => buildLegacyMigrationPreview(plan)) }
        : null;
    },
    async migrateLegacyState(input) {
      const plans = await resolvePlans(input);
      const { runLegacyMigrationPlans } = await import("../infra/state-migrations.plugin-state.js");
      return await runLegacyMigrationPlans(plans);
    },
  };
}
