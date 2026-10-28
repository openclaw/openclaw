import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { inspectPluginCapabilityArtifact } from "../plugins/capability-artifact.js";
import { buildPluginCapabilitySummary } from "../plugins/capability-summary.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../plugins/config-state.js";
import { isBundledPluginInsideDevSourceRoot } from "../plugins/dev-source-root.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolvePluginInstallDir,
} from "../plugins/install-paths.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-record-reader.js";
import { preparePluginMetadataMachineStateAsync } from "../plugins/installed-plugin-index-record-state.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { resolveUserPath } from "../utils.js";
import { resolveTemplatePluginSetupRequirements } from "./package-setup-requirements.js";
import type { TemplatePackage, TemplatePackagePreflightResult } from "./types.js";

export function inspectTemplatePluginCapabilities(
  rootDir: string,
  pluginId: string,
  env?: NodeJS.ProcessEnv,
  config: OpenClawConfig = {},
  currentArtifactDir?: string,
) {
  const { declared, manifest, manifests } = inspectPluginCapabilityArtifact(rootDir, env, {
    config,
    currentArtifactDir,
  });
  return {
    declared,
    grants: buildPluginCapabilitySummary({
      manifest: manifest ?? {},
      origin: "global",
      entryConfig: config.plugins?.entries?.[pluginId],
    }).grants,
    grantsByPluginId: Object.fromEntries(
      manifests
        .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((ownedManifest) => [
          ownedManifest.id,
          buildPluginCapabilitySummary({
            manifest: ownedManifest,
            origin: "global",
            entryConfig: config.plugins?.entries?.[ownedManifest.id],
          }).grants,
        ]),
    ),
  };
}

export type TemplatePluginProbeDeps = {
  probePlugin?: typeof installPluginFromClawHub;
  inspectPluginCapabilities?: typeof inspectTemplatePluginCapabilities;
  env?: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  currentArtifactDir?: string;
};

function configuredPathSelectsPlugin(
  configuredPath: string,
  pluginRoot: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const source = resolvePathViaExistingAncestorSync(resolveUserPath(configuredPath, env));
  const root = resolvePathViaExistingAncestorSync(pluginRoot);
  return source === root || source === path.dirname(root) || isPathInside(root, source);
}

export async function sourceHostPluginConflict(
  pkg: TemplatePackage,
  pluginId: string,
  options: Pick<TemplatePluginProbeDeps, "env" | "config">,
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const activate = await preparePluginMetadataMachineStateAsync({ env });
  const installRecords = await loadInstalledPluginIndexInstallRecords({ env });
  activate();
  const selectedPlugin = loadInstalledPluginIndex({
    config: options.config,
    env,
    installRecords,
  }).plugins.find((plugin) => plugin.pluginId === pluginId);
  if (
    selectedPlugin?.origin !== "bundled" ||
    !isBundledPluginInsideDevSourceRoot({ rootDir: selectedPlugin.rootDir, env })
  ) {
    return undefined;
  }
  const pendingInstallDir = resolvePluginInstallDir(
    pluginId,
    resolveDefaultPluginExtensionsDir(env),
  );
  for (const configuredPath of options.config?.plugins?.load?.paths ?? []) {
    if (configuredPathSelectsPlugin(configuredPath, selectedPlugin.rootDir, env)) {
      break;
    }
    if (configuredPathSelectsPlugin(configuredPath, pendingInstallDir, env)) {
      return undefined;
    }
  }
  return `Plugin ${pkg.ref}@${pkg.version} cannot become active because this source build prioritizes its bundled plugin ${pluginId}. Use a packaged OpenClaw build or a plugin with a distinct ID.`;
}

export async function probeTemplatePluginArtifact(
  pkg: TemplatePackage,
  isolateFromLiveExtensions: boolean,
  deps: TemplatePluginProbeDeps,
): Promise<
  Awaited<ReturnType<typeof installPluginFromClawHub>> & {
    declaredCapabilities?: PluginAcceptedDeclaredSurface;
    capabilityGrants?: ReturnType<typeof buildPluginCapabilitySummary>["grants"];
    capabilityGrantsByPluginId?: ReturnType<
      typeof inspectTemplatePluginCapabilities
    >["grantsByPluginId"];
  }
> {
  const probePlugin = deps.probePlugin ?? installPluginFromClawHub;
  const inspect = deps.inspectPluginCapabilities ?? inspectTemplatePluginCapabilities;
  let inspected: ReturnType<typeof inspectTemplatePluginCapabilities> | undefined;
  let inspectionError: unknown;
  const request = {
    spec: `clawhub:${pkg.ref}@${pkg.version}`,
    dryRun: true,
    requireClawHubTrust: true,
    config: deps.config,
    onPluginArtifactInspect: async (artifact: {
      pluginId: string;
      stagedArtifactDir: string;
      currentArtifactDir?: string;
    }) => {
      try {
        inspected = inspect(
          artifact.stagedArtifactDir,
          artifact.pluginId,
          deps.env,
          deps.config,
          deps.currentArtifactDir ?? artifact.currentArtifactDir,
        );
      } catch (error) {
        inspectionError = error;
      }
    },
  } as const;
  const workspace = isolateFromLiveExtensions
    ? await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-template-plugin-probe-",
      })
    : undefined;
  let probe: Awaited<ReturnType<typeof installPluginFromClawHub>>;
  try {
    probe = await probePlugin(workspace ? { ...request, extensionsDir: workspace.dir } : request);
  } finally {
    await workspace?.cleanup().catch(() => undefined);
  }
  if (!probe.ok) {
    return probe;
  }
  if (inspectionError !== undefined || !inspected) {
    return {
      ok: false,
      error: inspectionError
        ? `Plugin ${pkg.ref}@${pkg.version} capability inspection failed: ${coerceErrorMessage(inspectionError)}`
        : `Plugin ${pkg.ref}@${pkg.version} did not expose staged capability inspection.`,
    };
  }
  return {
    ...probe,
    declaredCapabilities: inspected.declared,
    capabilityGrants: inspected.grants,
    capabilityGrantsByPluginId: inspected.grantsByPluginId,
  };
}

export async function preflightTemplatePluginPackage(
  pkg: TemplatePackage,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    deps?: { preflightPlugin?: typeof preflightPluginInstall } & TemplatePluginProbeDeps;
  } = {},
): Promise<TemplatePackagePreflightResult> {
  const result = await (options.deps?.preflightPlugin ?? preflightPluginInstall)({
    clawhubPackage: pkg.ref,
    expectedVersion: pkg.version,
  });
  const probe = await probeTemplatePluginArtifact(
    pkg,
    !(result.ok && result.action === "install"),
    {
      ...options.deps,
      env: options.env,
      config: options.config,
      currentArtifactDir: result.installedPath,
    },
  );
  if (!probe.ok) {
    return { ok: false, code: probe.code ?? "plugin_preflight_failed", message: probe.error };
  }
  if (!probe.artifactInspection) {
    return {
      ok: false,
      code: "plugin_artifact_inspection_unavailable",
      message: `Plugin ${pkg.ref}@${pkg.version} did not return canonical artifact inspection.`,
    };
  }
  if (probe.artifactInspection.format === "agent") {
    return {
      ok: false,
      code: "plugin_artifact_format_unsupported",
      message: `Plugin ${pkg.ref}@${pkg.version} uses unsupported Template extension format agent.`,
    };
  }
  const integrity = probe.clawhub.integrity
    ? normalizeClawHubSha256Integrity(probe.clawhub.integrity)
    : null;
  if (!integrity) {
    return {
      ok: false,
      code: "plugin_integrity_unavailable",
      message: `Plugin ${pkg.ref}@${pkg.version} did not resolve an artifact integrity.`,
    };
  }
  const requirements = resolveTemplatePluginSetupRequirements({
    pluginId: probe.pluginId,
    setup: probe.setup,
    env: options.env ?? process.env,
  });
  const artifact = {
    integrity,
    installId: probe.pluginId,
    ...(requirements.length > 0 ? { requirements } : {}),
    detectedFormat: probe.artifactInspection.format,
    mapped: probe.artifactInspection.mapped,
    unavailable: probe.artifactInspection.unavailable,
    adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    ...(probe.warning ? { warning: probe.warning } : {}),
    declaredCapabilities: probe.declaredCapabilities,
    capabilityGrants: probe.capabilityGrants,
    capabilityGrantsByPluginId: probe.capabilityGrantsByPluginId,
  };
  const sourceHostConflict = await sourceHostPluginConflict(pkg, probe.pluginId, options);
  if (sourceHostConflict) {
    return {
      ok: false,
      code: "plugin_source_host_conflict",
      message: sourceHostConflict,
    };
  }
  if (options.config) {
    const pluginsConfig = normalizePluginsConfig(options.config.plugins);
    const explicitlyDisabled =
      pluginsConfig.entries[normalizePluginId(probe.pluginId)]?.enabled === false;
    const activation = resolveEffectiveEnableState({
      id: probe.pluginId,
      origin: "global",
      config: pluginsConfig,
      rootConfig: options.config,
    });
    if (!activation.enabled) {
      return {
        ok: false,
        code: "plugin_disabled",
        message:
          !result.ok || result.action === "install"
            ? explicitlyDisabled
              ? `Plugin ${pkg.ref}@${pkg.version} was explicitly disabled or uninstalled. Install and enable it in Plugins before adding this Template.`
              : !pluginsConfig.enabled
                ? `Plugin ${pkg.ref}@${pkg.version} cannot be enabled because plugins are disabled. Enable plugins in Plugins before adding this Template.`
                : `Plugin ${pkg.ref}@${pkg.version} is blocked by host policy (${activation.reason ?? "unknown"}). Change its policy in Plugins before adding this Template.`
            : `Plugin ${pkg.ref}@${pkg.version} is installed but disabled (${activation.reason ?? "host policy"}). Enable it in Plugins before continuing.`,
      };
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      installedVersion: result.installedVersion,
      ...artifact,
      message: `Plugin ${pkg.ref}@${pkg.version} conflicts with installed version ${result.installedVersion}.`,
    };
  }
  if (
    result.action === "reuse" &&
    (result.installedId !== probe.pluginId ||
      !result.installedIntegrity ||
      normalizeClawHubSha256Integrity(result.installedIntegrity) !== integrity)
  ) {
    return {
      ok: false,
      code: "plugin_integrity_conflict",
      message: `Plugin ${pkg.ref}@${pkg.version} is installed as ${result.installedId} with integrity ${result.installedIntegrity ?? "unknown"}, expected ${probe.pluginId} with ${integrity}.`,
    };
  }
  return {
    ok: true,
    action: result.action,
    ...artifact,
    ...(result.action === "reuse" && result.installedIntegrity
      ? { installedIntegrity: result.installedIntegrity }
      : {}),
    ...(result.action === "reuse" && result.installedAt ? { installedAt: result.installedAt } : {}),
  };
}
