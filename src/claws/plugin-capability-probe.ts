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
import { isBundledPluginInsideDevSourceRoot } from "../plugins/dev-source-root.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolvePluginInstallDir,
} from "../plugins/install-paths.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawPluginSetupRequirements } from "./package-setup-requirements.js";
import type { ClawPackage, ClawPackagePreflightResult } from "./types.js";

export function inspectClawPluginCapabilities(
  rootDir: string,
  pluginId: string,
  env?: NodeJS.ProcessEnv,
  config: OpenClawConfig = {},
  currentArtifactDir?: string,
) {
  const { declared, manifest } = inspectPluginCapabilityArtifact(rootDir, env, {
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
  };
}

export type ClawPluginProbeDeps = {
  probePlugin?: typeof installPluginFromClawHub;
  inspectPluginCapabilities?: typeof inspectClawPluginCapabilities;
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

export function sourceHostPluginConflict(
  pkg: ClawPackage,
  pluginId: string,
  options: Pick<ClawPluginProbeDeps, "env" | "config">,
): string | undefined {
  const env = options.env ?? process.env;
  const selectedPlugin = loadInstalledPluginIndex({ config: options.config, env }).plugins.find(
    (plugin) => plugin.pluginId === pluginId,
  );
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

export async function probeClawPluginArtifact(
  pkg: ClawPackage,
  isolateFromLiveExtensions: boolean,
  deps: ClawPluginProbeDeps,
): Promise<
  Awaited<ReturnType<typeof installPluginFromClawHub>> & {
    declaredCapabilities?: PluginAcceptedDeclaredSurface;
    capabilityGrants?: ReturnType<typeof buildPluginCapabilitySummary>["grants"];
  }
> {
  const probePlugin = deps.probePlugin ?? installPluginFromClawHub;
  const inspect = deps.inspectPluginCapabilities ?? inspectClawPluginCapabilities;
  let inspected: ReturnType<typeof inspectClawPluginCapabilities> | undefined;
  let inspectionError: unknown;
  const request = {
    spec: `clawhub:${pkg.ref}@${pkg.version}`,
    dryRun: true,
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
        prefix: "openclaw-claw-plugin-probe-",
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
  };
}

export async function preflightClawPluginPackage(
  pkg: ClawPackage,
  options: {
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    deps?: { preflightPlugin?: typeof preflightPluginInstall } & ClawPluginProbeDeps;
  } = {},
): Promise<ClawPackagePreflightResult> {
  const result = await (options.deps?.preflightPlugin ?? preflightPluginInstall)({
    clawhubPackage: pkg.ref,
    rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
    expectedVersion: pkg.version,
  });
  if (!result.ok && result.code !== "plugin_version_conflict") {
    return { ok: false, code: result.code, message: result.error };
  }
  const probe = await probeClawPluginArtifact(pkg, !(result.ok && result.action === "install"), {
    ...options.deps,
    env: options.env,
    config: options.config,
    currentArtifactDir: result.installedPath,
  });
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
      message: `Plugin ${pkg.ref}@${pkg.version} uses unsupported Claw extension format agent.`,
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
  const requirements = resolveClawPluginSetupRequirements({
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
  };
  const sourceHostConflict = sourceHostPluginConflict(pkg, probe.pluginId, options);
  if (sourceHostConflict) {
    return {
      ok: false,
      code: "plugin_source_host_conflict",
      message: sourceHostConflict,
    };
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
