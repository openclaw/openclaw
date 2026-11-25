// Offline check: inspect candidate metadata without booting or migrating live state.
import path from "node:path";
import { quietPluginJsonLogger } from "../cli/plugins-json-logger.js";
import { planLegacyConfigForUpdateChannel } from "../commands/doctor/legacy-config-repair.js";
import { createConfigIO } from "../config/io.factory.js";
import {
  normalizeConfigIoDeps,
  parseConfigJson5,
  readConfigFileIfPresent,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "../config/io.read-helpers.js";
import { resolveConfigIncludeWriteBoundary } from "../config/mutate.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { isConfiguredPluginPathDiagnosticCode } from "../plugins/discovery-availability.js";
import { getPersistedInstalledPluginIndexCacheEntry } from "../plugins/installed-plugin-index-record-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { buildPluginRegistrySnapshotReport } from "../plugins/status-snapshot.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { isUpgradeRestorePath, preflightStateUpgrade } from "../state/state-upgrade-databases.js";

type ReleaseSurface = { plugin: string; surface: string; error?: string };
export type CheckReleaseResult = {
  ok: boolean;
  reason?: string;
  surfaces: ReleaseSurface[];
  // Older releases do not include warnings in their result.
  warnings?: { code: string; message: string }[];
};

/** The upgrade inventory owns schema and recovery admission before the old Gateway stops. */
export async function checkRelease(
  options: {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
  } = {},
): Promise<CheckReleaseResult> {
  const env = { ...(options.env ?? process.env) };
  const surfaces: ReleaseSurface[] = [];
  const warnings: NonNullable<CheckReleaseResult["warnings"]> = [];
  const refuse = (reason: string): CheckReleaseResult => ({
    ok: false,
    reason,
    surfaces,
    warnings,
  });
  try {
    const deps = normalizeConfigIoDeps({ env, configPath: options.configPath, observe: false });
    const configPath = resolveConfigPathForDeps(deps);
    const parsed = parseConfigJson5(readConfigFileIfPresent(deps, configPath) ?? "{}");
    if (!parsed.ok) {
      return refuse(`config-invalid: ${parsed.error}`);
    }
    const included = resolveConfigIncludesForRead(parsed.parsed, configPath, deps);
    const { resolvedConfigRaw } = resolveConfigForRead(included, env);
    const validated = validateConfigObjectRaw(resolvedConfigRaw, { env });
    let config: OpenClawConfig;
    if (validated.ok) {
      config = validated.config;
    } else {
      // Admission projects the same captured include repair that startup commits;
      // candidate checks never publish it or flatten the authored include graph.
      const { snapshot, writeOptions } = await createConfigIO({
        env,
        configPath,
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshotForWrite();
      const plan = snapshot.includedPaths?.length
        ? withArtifactPreservingStateReads(() =>
            planLegacyConfigForUpdateChannel(snapshot, writeOptions),
          )
        : undefined;
      if (!plan?.changes.length) {
        return refuse(
          `config-invalid: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
        );
      }
      const boundary = resolveConfigIncludeWriteBoundary({ snapshot, nextConfig: plan.nextConfig });
      const includeTarget =
        boundary && writeOptions.includeFileTargetsForWrite?.[boundary.includePath];
      if (
        includeTarget &&
        !isUpgradeRestorePath(path.resolve(resolveStateDir(env)), includeTarget)
      ) {
        return refuse(
          `The release trial cannot restore changed included config ${includeTarget}. Run openclaw doctor --fix before retrying the update. Nothing live was changed.`,
        );
      }
      config = plan.config;
    }
    const { metadataRows } = await preflightStateUpgrade(env, config);
    return await withPluginCache(createPluginCache(), async () => {
      const activateDiscovery = await prepareBundledDiscoveryMode(env, async () =>
        metadataRows.find((row) => row.state_key === "plugins.bundledDiscovery"),
      );
      activateDiscovery();
      getPersistedInstalledPluginIndexCacheEntry({ env }, () =>
        metadataRows.find((row) => row.state_key === "plugins.installedIndex"),
      );
      return withArtifactPreservingStateReads(() => {
        const report = buildPluginRegistrySnapshotReport({
          config,
          env,
          logger: quietPluginJsonLogger,
        });
        for (const plugin of report.plugins) {
          surfaces.push({
            plugin: plugin.id,
            surface: "manifest",
            ...(plugin.error ? { error: plugin.error } : {}),
          });
        }
        for (const diagnostic of [...report.diagnostics, ...report.registryDiagnostics]) {
          if (
            diagnostic.level === "warn" &&
            isConfiguredPluginPathDiagnosticCode(diagnostic.code)
          ) {
            warnings.push({ code: diagnostic.code, message: diagnostic.message });
          }
          if (diagnostic.level === "error") {
            surfaces.push({
              plugin: diagnostic.pluginId ?? "core",
              surface: "inventory",
              error: diagnostic.message,
            });
          }
        }
        const coreError = surfaces.find((surface) => surface.plugin === "core" && surface.error);
        return coreError ? refuse(coreError.error!) : { ok: true, surfaces, warnings };
      });
    });
  } catch (error) {
    return refuse(formatErrorMessage(error));
  }
}
