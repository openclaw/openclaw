// Shared validation, auth-surface, and config-load helpers for Gateway startup.
import { isDeepStrictEqual } from "node:util";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import {
  formatInvalidConfigRecoveryHint,
  formatPluginPackagingRuntimeOutputRecoveryHint,
} from "../cli/config-recovery-hints.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import {
  type ReadConfigFileSnapshotWithPluginMetadataResult,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/io.js";
import { renderConfigValidationIssueLines } from "../config/issue-location.js";
import {
  inheritLegacyDefaultAgentId,
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../config/legacy.default-agent-owner.js";
import { materializeLegacyDefaultAgentRoles } from "../config/legacy.default-agent-roles.js";
import { isNixMode, resolveIsConfigReadOnly } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import {
  copyConfigResolutionFacts,
  copyConfigResolutionFactsExcept,
  hasUnresolvedConfigPath,
} from "../config/resolution-facts.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import { mergeGatewayAuthConfig, resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.types.js";
import { resolveGatewayStartupSourceConfig } from "./server-startup-secret-surfaces.js";
import { ensureGatewayStartupAuth, mergeGatewayTailscaleConfig } from "./startup-auth.js";

export type GatewayStartupLog = {
  info: (message: string) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string) => void;
};

export type GatewayStartupConfigMeasure = <T>(
  name: string,
  run: () => T | Promise<T>,
  options?: { omitErrorMessage?: boolean },
) => Promise<T>;

export type GatewayStartupConfigSnapshotLoadResult = {
  snapshot: ConfigFileSnapshot;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

/** Throw a formatted startup error when the loaded config snapshot is invalid. */
function assertValidGatewayStartupConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  options: { includeDoctorHint?: boolean } = {},
): void {
  if (snapshot.valid) {
    return;
  }
  const issues =
    snapshot.issues.length > 0
      ? renderConfigValidationIssueLines(snapshot, "").join("\n")
      : "Unknown validation issue.";
  const recoveryHint =
    options.includeDoctorHint && isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
      ? `\n${formatPluginPackagingRuntimeOutputRecoveryHint()}`
      : options.includeDoctorHint
        ? `\n${formatInvalidConfigRecoveryHint()}`
        : "";
  throw createInvalidConfigError(snapshot.path, `${issues}${recoveryHint}`, {
    recovery: isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot) ? "manual" : "doctor",
  });
}

function withRuntimeConfig(
  snapshot: ConfigFileSnapshot,
  runtimeConfig: OpenClawConfig,
): ConfigFileSnapshot {
  copyConfigResolutionFacts(snapshot.sourceConfig, runtimeConfig);
  return {
    ...snapshot,
    runtimeConfig,
    config: runtimeConfig,
  };
}

/** Load and validate the config snapshot, applying runtime-only plugin auto-enable changes. */
export async function loadGatewayStartupConfigSnapshot(params: {
  minimalTestGateway: boolean;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
  log: GatewayStartupLog;
  measure?: GatewayStartupConfigMeasure;
  initialSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
}): Promise<GatewayStartupConfigSnapshotLoadResult> {
  const measure = params.measure ?? (async (_name, run) => await run());
  const snapshotRead =
    params.initialSnapshotRead ??
    (await measure("config.snapshot.read", () =>
      readConfigFileSnapshotWithPluginMetadata({ measure }),
    ));
  const configSnapshot = snapshotRead.snapshot;
  const pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
  if (configSnapshot.legacyIssues.length > 0 && resolveIsConfigReadOnly()) {
    throw createInvalidConfigError(
      configSnapshot.path,
      isNixMode
        ? "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart."
        : "Legacy config entries detected in read-only config. Update your external config source to the latest schema and restart.",
      { recovery: "manual" },
    );
  }
  if (configSnapshot.exists) {
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }

  const autoEnable = params.minimalTestGateway
    ? { config: configSnapshot.config, changes: [] as string[] }
    : await measure("config.snapshot.auto-enable", () =>
        applyPluginAutoEnable({
          config: configSnapshot.sourceConfig,
          env: process.env,
          ambientEnvTriggers: params.ambientEnvTriggers,
          ...(pluginMetadataSnapshot?.manifestRegistry
            ? { manifestRegistry: pluginMetadataSnapshot.manifestRegistry }
            : {}),
          discovery: pluginMetadataSnapshot?.discovery,
        }),
      );
  if (autoEnable.changes.length === 0) {
    return {
      snapshot: configSnapshot,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    };
  }

  params.log.info(
    `gateway: auto-enabled plugins for this runtime without writing config:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
  );
  const autoEnabledRuntimeConfig = mergeActivationSectionsIntoRuntimeConfig({
    runtimeConfig: configSnapshot.runtimeConfig,
    activationConfig: autoEnable.config,
  });
  const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(configSnapshot.sourceConfig);
  const runtimeConfig = legacyDefaultAgentId
    ? materializeLegacyDefaultAgentRoles(autoEnabledRuntimeConfig, legacyDefaultAgentId).config
    : autoEnabledRuntimeConfig;
  retainLegacyDefaultAgentId(runtimeConfig, legacyDefaultAgentId);
  return {
    snapshot: withRuntimeConfig(configSnapshot, runtimeConfig),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  };
}

export function hasActiveGatewayAuthSecretRef(config: OpenClawConfig): boolean {
  const states = evaluateGatewayAuthSurfaceStates({
    config,
    defaults: config.secrets?.defaults,
    env: process.env,
  });
  return GATEWAY_AUTH_SURFACE_PATHS.some((path) => {
    const state = states[path];
    return state.hasSecretRef && state.active;
  });
}

export function assertRuntimeGatewayAuthNotKnownWeak(config: OpenClawConfig): void {
  assertGatewayAuthNotKnownWeak(
    resolveGatewayAuthForConfig({
      config,
      env: process.env,
      tailscaleMode: config.gateway?.tailscale?.mode ?? "off",
    }),
    config.gateway?.auth?.token,
    config.gateway?.auth?.password,
  );
}

export function logGatewayAuthSurfaceDiagnostics(
  prepared: {
    sourceConfig: OpenClawConfig;
    warnings: Array<{ code: string; path: string; message: string }>;
  },
  logSecrets: GatewayStartupLog,
): void {
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,
  });
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;
    }
    const stateLabel = state.active ? "active" : "inactive";
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

export function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: { auth?: GatewayAuthConfig; tailscale?: GatewayTailscaleConfig },
): OpenClawConfig {
  if (!overrides.auth && !overrides.tailscale) {
    return config;
  }
  const next = {
    ...config,
    gateway: {
      ...config.gateway,
      ...(overrides.auth
        ? { auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth) }
        : {}),
      ...(overrides.tailscale
        ? { tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale) }
        : {}),
    },
  };
  copyConfigResolutionFactsExcept(config, next, [
    ...(overrides.auth?.token !== undefined ? ["gateway.auth.token"] : []),
    ...(overrides.auth?.password !== undefined ? ["gateway.auth.password"] : []),
  ]);
  return next;
}

/** Prepare the effective Gateway startup config after auth, overrides, and secrets activation. */
export async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  log?: GatewayStartupLog;
  measure?: GatewayStartupConfigMeasure;
}): Promise<Awaited<ReturnType<typeof ensureGatewayStartupAuth>>> {
  const measure = params.measure ?? (async (_name, run) => await run());
  await measure("config.auth.snapshot-validate", () =>
    assertValidGatewayStartupConfigSnapshot(params.configSnapshot),
  );

  const runtimeConfig = await measure("config.auth.runtime-overrides", () =>
    applyConfigOverrides(params.configSnapshot.config),
  );
  copyConfigResolutionFacts(params.configSnapshot.config, runtimeConfig);
  const startupPreflightConfig = await measure("config.auth.startup-overrides", () =>
    applyGatewayAuthOverridesForStartupPreflight(runtimeConfig, {
      auth: params.authOverride,
      tailscale: params.tailscaleOverride,
    }),
  );
  const needsAuthSecretPreflight = await measure("config.auth.secret-surface", () =>
    hasActiveGatewayAuthSecretRef(startupPreflightConfig),
  );
  let preflightPrepared: Awaited<ReturnType<ActivateRuntimeSecrets>> | undefined;
  const preflightConfig = await measure(
    "config.auth.secret-preflight",
    async () => {
      if (!needsAuthSecretPreflight) {
        return startupPreflightConfig;
      }
      preflightPrepared = await params.activateRuntimeSecrets(startupPreflightConfig, {
        reason: "startup",
        activate: false,
      });
      return preflightPrepared.config;
    },
    { omitErrorMessage: true },
  );
  const activateStartupSecrets = async (config: OpenClawConfig) => {
    // Reuse the preflight snapshot only if generated startup auth did not
    // change the secret-relevant source config.
    if (
      preflightPrepared &&
      isDeepStrictEqual(
        resolveGatewayStartupSourceConfig(config, process.env),
        preflightPrepared.sourceConfig,
      )
    ) {
      return await params.activateRuntimeSecrets.activatePreparedSnapshot(preflightPrepared, {
        reason: "startup",
        activate: true,
      });
    }
    return await params.activateRuntimeSecrets(config, {
      reason: "startup",
      activate: true,
    });
  };
  const preflightAuthOverride = await measure("config.auth.preflight-override", () => {
    const token = preflightConfig.gateway?.auth?.token;
    const password = preflightConfig.gateway?.auth?.password;
    const resolvedToken =
      typeof token === "string" && !hasUnresolvedConfigPath(preflightConfig, "gateway.auth.token");
    const resolvedPassword =
      typeof password === "string" &&
      !hasUnresolvedConfigPath(preflightConfig, "gateway.auth.password");
    return resolvedToken || resolvedPassword
      ? {
          ...params.authOverride,
          ...(resolvedToken ? { token } : {}),
          ...(resolvedPassword ? { password } : {}),
        }
      : params.authOverride;
  });

  const authBootstrap = await measure("config.auth.ensure", () =>
    ensureGatewayStartupAuth({
      cfg: runtimeConfig,
      env: process.env,
      authOverride: preflightAuthOverride,
      tailscaleOverride: params.tailscaleOverride,
      warn: params.log?.warn,
    }),
  );
  const runtimeStartupConfig = await measure("config.auth.runtime-startup-overrides", () =>
    applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
      auth: params.authOverride,
      tailscale: params.tailscaleOverride,
    }),
  );
  const activatedConfig = (
    await measure(
      "config.auth.secrets-activate",
      () => activateStartupSecrets(runtimeStartupConfig),
      { omitErrorMessage: true },
    )
  ).config;
  const config = inheritLegacyDefaultAgentId(params.configSnapshot.config, activatedConfig);
  copyConfigResolutionFacts(activatedConfig, config);
  return { ...authBootstrap, cfg: config };
}
