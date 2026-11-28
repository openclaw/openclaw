import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { areBundledPluginsDisabled } from "../plugins/bundled-dir.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { OpenClawPluginServiceV2 } from "../plugins/plugin-registration.types.js";
import { loadValidatedPublicSurfaceModule } from "../plugins/public-surface-loader.js";
import { resolveBundledPluginPublicSurfacePath } from "../plugins/public-surface-runtime.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { addPluginServiceRegistration } from "../plugins/service-registration.js";

/** Keep the former core watcher in the ordinary service lifecycle with plugin discovery off. */
export function registerShippedGmailWatcher(
  registry: PluginRegistry,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  loadModules: boolean,
): void {
  const { deny, entries } = normalizePluginsConfig(config.plugins);
  if (
    deny.includes("gmail") ||
    entries.gmail?.enabled === false ||
    isTruthyEnvValue(env.OPENCLAW_SKIP_GMAIL_WATCHER) ||
    areBundledPluginsDisabled(env)
  ) {
    return;
  }

  // Pin lookup to this installation. A configured load path or same-ID installed plugin
  // must never supply code for a Gateway with general plugin loading disabled.
  const packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  const source =
    packageRoot &&
    resolveBundledPluginPublicSurfacePath({
      rootDir: packageRoot,
      bundledPluginsDir: path.join(packageRoot, "dist", "extensions"),
      dirName: "gmail",
      artifactBasename: "api.js",
    });
  if (!source || !packageRoot) {
    registry.diagnostics.push({
      level: "error",
      pluginId: "gmail",
      message: "Configured Gmail watcher is missing from this OpenClaw installation.",
    });
    return;
  }

  const record = createPluginRecord({
    id: "gmail",
    name: "Gmail Pub/Sub",
    origin: "bundled",
    rootDir: path.dirname(source),
    source,
    enabled: false,
    configSchema: false,
  });
  // Replacement preflight needs the owner identity to stop a prior watcher when policy changes.
  registry.plugins.push(record);
  if (!loadModules) {
    return;
  }
  const { createGmailWatcherService } = loadValidatedPublicSurfaceModule({
    modulePath: source,
    boundaryRoot: packageRoot,
    origin: "bundled",
    pluginId: "gmail",
    surfaceLabel: "shipped Gmail watcher",
    capturedSource: true,
  }) as { createGmailWatcherService: () => OpenClawPluginServiceV2 }; // SAFETY: The pinned Gmail API shipped in this package exports the V2 factory.
  const service = createGmailWatcherService();
  addPluginServiceRegistration(registry, record, service.id, service);
}
