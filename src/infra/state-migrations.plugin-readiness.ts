import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLeaseAsync } from "../plugins/plugin-lifecycle-lease.js";
import {
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";

/** A running Gateway can certify an already-finished upgrade, but never run offline repairs. */
export async function confirmPluginStateMigrationReadiness(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  warn: (message: string) => void;
}): Promise<void> {
  const expectedPending = await readDeferredPluginMigrationsAsync({ env: params.env });
  if (expectedPending.length === 0) {
    return;
  }
  const [{ collectPluginDoctorStateMigrationPlans }, { validateConfigObjectRawWithPlugins }] =
    await Promise.all([
      import("./state-migrations.plugin-doctor.js"),
      import("../config/validation.js"),
    ]);
  await withPluginLifecycleLeaseAsync(
    { env: params.env, signal: params.signal, waitMs: 0 },
    async (lease) => {
      const stateDir = resolveStateDir(params.env);
      const input = {
        config: params.config,
        env: params.env,
        stateDir,
        oauthDir: resolveOAuthDir(params.env, stateDir),
      };
      const warnings: string[] = [];
      const options = {
        includeDoctorOnly: true,
        pluginIds: expectedPending.map((pending) => pending.pluginId),
        warnings,
      };
      // Doctor-only describes mutation authority. Its inspection callbacks remain read-only.
      const earlier = await collectPluginDoctorStateMigrationPlans(input, options);
      const later = await collectPluginDoctorStateMigrationPlans(input, {
        ...options,
        phase: "after-session-repair",
      });
      lease.assertCurrent();
      const completed = expectedPending.filter(
        ({ pluginId, requiresStateMigration }) =>
          (earlier.inspectedPluginIds.has(pluginId) ||
            (!requiresStateMigration && earlier.statelessPluginIds.has(pluginId))) &&
          (later.inspectedPluginIds.has(pluginId) ||
            (!requiresStateMigration && later.statelessPluginIds.has(pluginId))) &&
          ![...earlier.plans, ...later.plans].some((plan) => plan.pluginId === pluginId),
      );
      const resolvedPluginIds = completed.map(({ pluginId }) => pluginId);
      const validation = completed.length
        ? validateConfigObjectRawWithPlugins(params.config, {
            env: params.env,
            deferredPluginMigrations: expectedPending.filter(
              ({ pluginId }) => !resolvedPluginIds.includes(pluginId),
            ),
          })
        : undefined;
      if (validation && !validation.ok) {
        params.warn(
          `Plugin data/settings upgrade awaits config repair: ${validation.issues.map((issue) => issue.path).join(", ")}. Run openclaw doctor --fix.`,
        );
      } else if (completed.length > 0) {
        lease.assertCurrent();
        await recordDeferredPluginMigrations({
          env: params.env,
          expectedPending,
          pending: [],
          resolvedPluginIds,
        });
      }
      for (const warning of warnings) {
        params.warn(warning);
      }
      for (const plan of [...earlier.plans, ...later.plans]) {
        params.warn(
          `Plugin "${plan.pluginId}" data/settings upgrade is blocked in ${plan.migration.phase ?? "default"}: ${plan.migration.label}. Stop the Gateway through its service owner, then run openclaw doctor --fix.`,
        );
      }
      for (const pending of expectedPending) {
        if (pending.requiresStateMigration && earlier.statelessPluginIds.has(pending.pluginId)) {
          params.warn(
            `Plugin "${pending.pluginId}" data/settings upgrade is blocked: its installed contract has no detector for the required state migration. Ask the plugin maintainer for a supported migration; existing data and settings have been kept.`,
          );
        }
      }
    },
  );
}
