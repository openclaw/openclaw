import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { runDoctorHealthRepairs } from "../flows/doctor-repair-flow.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import { resolvePluginRootArtifactPath } from "./root-artifact-path.js";
import type {
  PluginRuntimeMaintenanceApiV1,
  PluginRuntimeMaintenanceContextV1,
} from "./runtime-maintenance-types.js";

export type PluginRuntimeMaintenanceAuthority = Pick<
  PluginRuntimeMaintenanceContextV1,
  "operation" | "signal" | "assertCurrent"
>;

/** Explicit lifecycle work only; ordinary Doctor and runtime acquisition never invoke this. */
export async function runPluginRuntimeMaintenance(
  params: PluginRuntimeMaintenanceAuthority & {
    config: OpenClawConfig;
    /** Omission selects enabled owners for a full OpenClaw update. */
    pluginIds?: readonly string[];
    env?: NodeJS.ProcessEnv;
    runtime?: Pick<RuntimeEnv, "log">;
  },
): Promise<string[]> {
  const env = params.env ?? process.env;
  params.signal.throwIfAborted();
  params.assertCurrent();
  // Rehearsal copies state, not platform applications. Never mutate the host from a canary.
  if (
    resolveUpdateRehearsalRoot(env) ||
    resolveUpdateRehearsalRoot(process.env) ||
    params.pluginIds?.length === 0
  ) {
    return [];
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([
    resolveCommandProcessSignal(params.signal) ?? params.signal,
    controller.signal,
  ]);
  let refusal: { error: unknown } | undefined;
  const assertCurrent = () => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      signal.throwIfAborted();
      params.assertCurrent();
    } catch (error) {
      refusal = { error };
      controller.abort(error);
      throw error;
    }
  };
  const warnings: string[] = [];
  const runtime: RuntimeEnv = { ...defaultRuntime, log: params.runtime?.log ?? defaultRuntime.log };
  await using cache = createPluginCache();
  return await withCommandProcessScope(async () => {
    try {
      return await withPluginCache(cache, async () => {
        const registry = loadPluginManifestRegistryForPluginRegistry({
          config: params.config,
          env,
          pluginIds: params.pluginIds,
          allowCurrent: false,
        });
        for (const owner of registry.plugins) {
          if (
            owner.doctorHealthChecks !== true ||
            (owner.origin !== "bundled" && owner.trustedOfficialInstall !== true)
          ) {
            continue;
          }
          assertCurrent();
          try {
            const extensions = /\.[cm]?ts$/u.test(owner.source)
              ? ["ts", "mts", "cts", "js", "mjs", "cjs"]
              : ["js", "mjs", "cjs", "ts", "mts", "cts"];
            const artifact = resolvePluginRootArtifactPath(
              owner.rootDir,
              extensions.flatMap((extension) => [
                `doctor-health-api.${extension}`,
                path.join("dist", `doctor-health-api.${extension}`),
              ]),
            );
            // Older plugins may declare ordinary Doctor checks without runtime maintenance.
            if (!artifact) {
              continue;
            }
            const load = getPluginSetupModuleLoader(owner, artifact, owner.rootDir);
            // SAFETY: The official owner's V1 factory signature is checked for callability below.
            const api = load(artifact) as Partial<PluginRuntimeMaintenanceApiV1>;
            const createChecks = api.createPluginRuntimeMaintenanceChecksV1;
            if (typeof createChecks !== "function") {
              continue;
            }
            const checks = load.initialize(() =>
              createChecks({
                operation: params.operation,
                pluginRoot: owner.rootDir,
                signal,
                assertCurrent,
              }),
            );
            const result = await runDoctorHealthRepairs(
              { mode: "fix", cfg: params.config, env, runtime },
              { checks },
            );
            // The Doctor runner intentionally converts repair failures to diagnostics.
            // It must not convert revoked lifecycle authority into successful completion.
            assertCurrent();
            for (const change of result.changes) {
              runtime.log(change);
            }
            warnings.push(
              ...result.warnings,
              ...result.remainingFindings.map((finding) => finding.message),
            );
          } catch (error) {
            assertCurrent();
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            warnings.push(
              `Plugin ${owner.id} runtime maintenance failed: ${scrubDoctorErrorMessage(error)}. Retry openclaw plugins update ${owner.id}.`,
            );
          }
        }
        assertCurrent();
        return [...new Set(warnings)];
      });
    } catch (error) {
      assertCurrent();
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      return [
        ...new Set([
          ...warnings,
          `Plugin runtime maintenance was unavailable: ${scrubDoctorErrorMessage(error)}. Retry openclaw plugins update --all after repairing the plugin inventory.`,
        ]),
      ];
    } finally {
      // Revoke retained plugin callbacks before command/cache cleanup yields.
      controller.abort();
    }
  }, signal);
}
