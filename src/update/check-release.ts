// Offline check: inspect candidate metadata without booting or migrating live state.
import { quietPluginJsonLogger } from "../cli/plugins-json-logger.js";
import {
  normalizeConfigIoDeps,
  parseConfigJson5,
  readConfigFileIfPresent,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "../config/io.read-helpers.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { getPersistedInstalledPluginIndexCacheEntry } from "../plugins/installed-plugin-index-record-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { buildPluginRegistrySnapshotReport } from "../plugins/status-snapshot.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { preflightStateUpgrade } from "../state/state-upgrade-databases.js";

type ReleaseSurface = { plugin: string; surface: string; error?: string };
export type CheckReleaseResult = { ok: boolean; reason?: string; surfaces: ReleaseSurface[] };

/** The upgrade inventory owns schema and recovery admission before the old Gateway stops. */
export async function checkRelease(
  options: {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
  } = {},
): Promise<CheckReleaseResult> {
  const env = { ...(options.env ?? process.env) };
  const surfaces: ReleaseSurface[] = [];
  const refuse = (reason: string): CheckReleaseResult => ({ ok: false, reason, surfaces });
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
    if (!validated.ok) {
      return refuse(
        `config-invalid: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    const config = validated.config;
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
          if (diagnostic.level === "error") {
            surfaces.push({
              plugin: diagnostic.pluginId ?? "core",
              surface: "inventory",
              error: diagnostic.message,
            });
          }
        }
        const coreError = surfaces.find((surface) => surface.plugin === "core" && surface.error);
        return coreError ? refuse(coreError.error!) : { ok: true, surfaces };
      });
    });
  } catch (error) {
    return refuse(formatErrorMessage(error));
  }
}
