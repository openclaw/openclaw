import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { inspectPluginCapabilityArtifact } from "../plugins/capability-artifact.js";
import { buildPluginCapabilitySummary } from "../plugins/capability-summary.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
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
  createProbeExtensionsDir?: () => Promise<string>;
  removeProbeExtensionsDir?: (path: string) => Promise<void>;
};

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
  const inspectPluginCapabilities = deps.inspectPluginCapabilities ?? inspectClawPluginCapabilities;
  let stagedDeclaredCapabilities: PluginAcceptedDeclaredSurface | undefined;
  let stagedCapabilityGrants: ReturnType<typeof buildPluginCapabilitySummary>["grants"] | undefined;
  let stagedInspectionError: unknown;
  const request = {
    spec: `clawhub:${pkg.ref}@${pkg.version}`,
    dryRun: true,
    config: deps.config,
    onPluginArtifactInspect: async ({
      pluginId,
      stagedArtifactDir,
      currentArtifactDir,
    }: {
      pluginId: string;
      stagedArtifactDir: string;
      currentArtifactDir?: string;
    }) => {
      try {
        const inspected = inspectPluginCapabilities(
          stagedArtifactDir,
          pluginId,
          deps.env,
          deps.config,
          deps.currentArtifactDir ?? currentArtifactDir,
        );
        stagedDeclaredCapabilities = inspected.declared;
        stagedCapabilityGrants = inspected.grants;
      } catch (error) {
        stagedInspectionError = error;
      }
    },
  } as const;
  const withDeclaredCapabilities = (
    result: Awaited<ReturnType<typeof installPluginFromClawHub>>,
  ) => {
    if (!result.ok) {
      return result;
    }
    if (stagedInspectionError !== undefined) {
      return {
        ok: false as const,
        error: `Plugin ${pkg.ref}@${pkg.version} capability inspection failed: ${coerceErrorMessage(stagedInspectionError)}`,
      };
    }
    if (!result.targetDir) {
      return {
        ok: false as const,
        error: `Plugin ${pkg.ref}@${pkg.version} did not return a staged artifact directory.`,
      };
    }
    try {
      const inspected =
        stagedDeclaredCapabilities && stagedCapabilityGrants
          ? { declared: stagedDeclaredCapabilities, grants: stagedCapabilityGrants }
          : inspectPluginCapabilities(
              result.targetDir,
              result.pluginId,
              deps.env,
              deps.config,
              deps.currentArtifactDir,
            );
      return {
        ...result,
        declaredCapabilities: inspected.declared,
        capabilityGrants: inspected.grants,
      };
    } catch (error) {
      return {
        ok: false as const,
        error: `Plugin ${pkg.ref}@${pkg.version} capability inspection failed: ${coerceErrorMessage(error)}`,
      };
    }
  };
  if (!isolateFromLiveExtensions) {
    return withDeclaredCapabilities(await probePlugin(request));
  }
  const probeExtensionsDir = await (deps.createProbeExtensionsDir?.() ??
    mkdtemp(join(tmpdir(), "openclaw-claw-plugin-probe-")));
  try {
    return withDeclaredCapabilities(
      await probePlugin({ ...request, extensionsDir: probeExtensionsDir }),
    );
  } finally {
    try {
      await (deps.removeProbeExtensionsDir?.(probeExtensionsDir) ??
        rm(probeExtensionsDir, { recursive: true, force: true }));
    } catch {
      // Temporary probe cleanup must not replace the canonical preflight result.
    }
  }
}

export type ClawPluginPreflightOptions = {
  env?: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  deps?: { preflightPlugin?: typeof preflightPluginInstall } & ClawPluginProbeDeps;
};

export async function preflightClawPluginPackage(
  pkg: ClawPackage,
  options: ClawPluginPreflightOptions = {},
): Promise<ClawPackagePreflightResult> {
  const result = await (options.deps?.preflightPlugin ?? preflightPluginInstall)({
    clawhubPackage: pkg.ref,
    rawSpec: `clawhub:${pkg.ref}@${pkg.version}`,
    expectedVersion: pkg.version,
  });
  if (!result.ok && result.code !== "plugin_version_conflict") {
    return {
      ok: false,
      code: result.code,
      message: result.error,
    };
  }
  const probe = await probeClawPluginArtifact(pkg, !(result.ok && result.action === "install"), {
    ...options.deps,
    env: options.env,
    config: options.config,
    ...(result.installedPath ? { currentArtifactDir: result.installedPath } : {}),
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
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      installedVersion: result.installedVersion,
      integrity,
      installId: probe.pluginId,
      ...(requirements.length > 0 ? { requirements } : {}),
      detectedFormat: probe.artifactInspection.format,
      mapped: probe.artifactInspection.mapped,
      unavailable: probe.artifactInspection.unavailable,
      adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
      ...(probe.warning ? { warning: probe.warning } : {}),
      ...(probe.declaredCapabilities ? { declaredCapabilities: probe.declaredCapabilities } : {}),
      ...(probe.capabilityGrants ? { capabilityGrants: probe.capabilityGrants } : {}),
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
    integrity,
    installId: probe.pluginId,
    ...(result.action === "reuse" && result.installedIntegrity
      ? { installedIntegrity: result.installedIntegrity }
      : {}),
    ...(result.action === "reuse" && result.installedAt ? { installedAt: result.installedAt } : {}),
    ...(requirements.length > 0 ? { requirements } : {}),
    detectedFormat: probe.artifactInspection.format,
    mapped: probe.artifactInspection.mapped,
    unavailable: probe.artifactInspection.unavailable,
    adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    ...(probe.warning ? { warning: probe.warning } : {}),
    ...(probe.declaredCapabilities ? { declaredCapabilities: probe.declaredCapabilities } : {}),
    ...(probe.capabilityGrants ? { capabilityGrants: probe.capabilityGrants } : {}),
  };
}
