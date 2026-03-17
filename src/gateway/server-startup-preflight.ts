import { formatCliCommand } from "../cli/command-format.js";
import {
  migrateLegacyConfig,
  type ConfigFileSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { GatewayRuntimeConfig } from "./server-runtime-config.js";

export type GatewayStartupPreflightPhase =
  | "config_legacy_migration"
  | "config_validation"
  | "plugin_auto_enable"
  | "runtime_config_resolution"
  | "control_ui_root_resolution";

export type GatewayStartupContext = {
  preflightSnapshot: ConfigFileSnapshot;
  secretsPrechecked: boolean;
  authBootstrap: {
    generatedToken: boolean;
    persistedGeneratedToken: boolean;
  };
  config: OpenClawConfig;
  diagnosticsEnabled: boolean;
  runtimeConfig?: GatewayRuntimeConfig;
  controlUiRootState?: ControlUiRootState;
};

export class GatewayStartupPreflightError extends Error {
  readonly phase: GatewayStartupPreflightPhase;

  constructor(
    phase: GatewayStartupPreflightPhase,
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "GatewayStartupPreflightError";
    this.phase = phase;
  }
}

function isGatewayStartupPreflightPhase(value: unknown): value is GatewayStartupPreflightPhase {
  return (
    value === "config_legacy_migration" ||
    value === "config_validation" ||
    value === "plugin_auto_enable" ||
    value === "runtime_config_resolution" ||
    value === "control_ui_root_resolution"
  );
}

function formatStartupPhaseErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  if (typeof err === "string" && err.trim().length > 0) {
    return err;
  }
  return fallback;
}

export function classifyGatewayStartupPreflightError(
  err: unknown,
): { phase: GatewayStartupPreflightPhase; message: string } | null {
  if (err instanceof GatewayStartupPreflightError) {
    return { phase: err.phase, message: err.message };
  }
  if (!err || typeof err !== "object") {
    return null;
  }
  const candidate = err as { name?: unknown; phase?: unknown; message?: unknown };
  if (candidate.name !== "GatewayStartupPreflightError") {
    return null;
  }
  if (!isGatewayStartupPreflightPhase(candidate.phase)) {
    return null;
  }
  if (typeof candidate.message !== "string" || candidate.message.length === 0) {
    return null;
  }
  return {
    phase: candidate.phase,
    message: candidate.message,
  };
}

export function formatGatewayStartupPreflightFailure(err: unknown): string | null {
  const classified = classifyGatewayStartupPreflightError(err);
  if (!classified) {
    return null;
  }
  return `Gateway startup phase failed (${classified.phase}): ${classified.message}`;
}

type GatewayStartupPreflightDeps = {
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  isNixMode: boolean;
  env?: NodeJS.ProcessEnv;
  migrateLegacyConfigFn?: typeof migrateLegacyConfig;
  applyPluginAutoEnableFn?: typeof applyPluginAutoEnable;
};

function buildInvalidConfigMessage(snapshot: ConfigFileSnapshot): string {
  const issues =
    snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  return `Invalid config at ${snapshot.path}.\n${issues}\nRun "${formatCliCommand("openclaw doctor")}" to repair, then retry.`;
}

function buildInvalidConfigMessageForStartupSecretPrecheck(snapshot: ConfigFileSnapshot): string {
  const issues =
    snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  return `Invalid config at ${snapshot.path}.\n${issues}`;
}

/**
 * Startup phase: normalize and validate config before runtime boot.
 * This keeps startup-side writes explicit and phase-scoped.
 */
export async function runGatewayStartupConfigPreflight(
  deps: GatewayStartupPreflightDeps,
): Promise<GatewayStartupContext> {
  const migrateLegacy = deps.migrateLegacyConfigFn ?? migrateLegacyConfig;
  const autoEnablePlugins = deps.applyPluginAutoEnableFn ?? applyPluginAutoEnable;
  const env = deps.env ?? process.env;

  let configSnapshot = await deps.readSnapshot();
  if (configSnapshot.legacyIssues.length > 0) {
    if (deps.isNixMode) {
      throw new GatewayStartupPreflightError(
        "config_legacy_migration",
        "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      );
    }
    const { config: migrated, changes } = migrateLegacy(configSnapshot.parsed);
    if (!migrated) {
      deps.log.warn(
        "gateway: legacy config entries detected but no auto-migration changes were produced; continuing with validation.",
      );
    } else {
      await deps.writeConfig(migrated);
      if (changes.length > 0) {
        deps.log.info(
          `gateway: migrated legacy config entries:\n${changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
    }
  }

  configSnapshot = await deps.readSnapshot();
  if (configSnapshot.exists && !configSnapshot.valid) {
    throw new GatewayStartupPreflightError(
      "config_validation",
      buildInvalidConfigMessage(configSnapshot),
    );
  }

  const autoEnable = autoEnablePlugins({
    config: configSnapshot.config,
    env,
  });
  if (autoEnable.changes.length === 0) {
    return createGatewayStartupContext(configSnapshot);
  }

  try {
    await deps.writeConfig(autoEnable.config);
    deps.log.info(
      `gateway: auto-enabled plugins:\n${autoEnable.changes
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    );
    return createGatewayStartupContext(await deps.readSnapshot());
  } catch (err) {
    deps.log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    return createGatewayStartupContext(configSnapshot);
  }
}

type GatewayStartupSecretsPrecheckDeps = {
  context: GatewayStartupContext;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  prepareConfig: (config: OpenClawConfig) => OpenClawConfig;
  activateRuntimeSecrets: (config: OpenClawConfig) => Promise<void>;
};

type StartupAuthBootstrapResult = {
  cfg: OpenClawConfig;
  generatedToken?: string;
  persistedGeneratedToken: boolean;
};

type GatewayStartupAuthBootstrapDeps = {
  loadConfig: () => OpenClawConfig;
  context: GatewayStartupContext;
  ensureGatewayStartupAuth: (params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    authOverride?: unknown;
    tailscaleOverride?: unknown;
    persist: true;
  }) => Promise<StartupAuthBootstrapResult>;
  activateRuntimeSecrets: (config: OpenClawConfig) => Promise<{ config: OpenClawConfig }>;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  authOverride?: unknown;
  tailscaleOverride?: unknown;
};

type GatewayStartupRuntimePolicyDeps = {
  context: GatewayStartupContext;
  isDiagnosticsEnabled: (config: OpenClawConfig) => boolean;
  startDiagnosticHeartbeat: () => void;
  isRestartEnabled: (config: OpenClawConfig) => boolean;
  setGatewaySigusr1RestartPolicy: (opts: { allowExternal: boolean }) => void;
  setPreRestartDeferralCheck: (check: () => number) => void;
  getPendingWorkCount: () => number;
  seedControlUiAllowedOrigins: (config: OpenClawConfig) => Promise<OpenClawConfig>;
};

type GatewayStartupRuntimeConfigPhaseDeps = {
  context: GatewayStartupContext;
  resolveRuntimeConfig: (config: OpenClawConfig) => Promise<GatewayRuntimeConfig>;
};

type GatewayStartupControlUiRootPhaseDeps = {
  context: GatewayStartupContext & { runtimeConfig: GatewayRuntimeConfig };
  resolveControlUiRootState: (params: {
    runtimeConfig: GatewayRuntimeConfig;
  }) => Promise<ControlUiRootState | undefined>;
};

/**
 * Startup phase: fail-fast secrets precheck before runtime boot.
 */
export async function runGatewayStartupSecretsPrecheck(
  deps: GatewayStartupSecretsPrecheckDeps,
): Promise<GatewayStartupContext> {
  const freshSnapshot = await deps.readSnapshot();
  if (!freshSnapshot.valid) {
    throw new GatewayStartupPreflightError(
      "config_validation",
      buildInvalidConfigMessageForStartupSecretPrecheck(freshSnapshot),
    );
  }
  const startupPreflightConfig = deps.prepareConfig(freshSnapshot.config);
  await deps.activateRuntimeSecrets(startupPreflightConfig);
  return {
    ...deps.context,
    preflightSnapshot: freshSnapshot,
    config: freshSnapshot.config,
    secretsPrechecked: true,
  };
}

/**
 * Startup phase: resolve gateway auth and activate runtime secrets.
 */
export async function runGatewayStartupAuthBootstrap(
  deps: GatewayStartupAuthBootstrapDeps,
): Promise<GatewayStartupContext> {
  const env = deps.env ?? process.env;

  let cfgAtStart = deps.loadConfig();
  const authBootstrap = await deps.ensureGatewayStartupAuth({
    cfg: cfgAtStart,
    env,
    authOverride: deps.authOverride,
    tailscaleOverride: deps.tailscaleOverride,
    persist: true,
  });
  cfgAtStart = authBootstrap.cfg;
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      deps.log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      deps.log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }

  return {
    ...deps.context,
    config: (await deps.activateRuntimeSecrets(cfgAtStart)).config,
    authBootstrap: {
      generatedToken: Boolean(authBootstrap.generatedToken),
      persistedGeneratedToken: authBootstrap.persistedGeneratedToken,
    },
  };
}

export function createGatewayStartupContext(
  preflightSnapshot: ConfigFileSnapshot,
): GatewayStartupContext {
  return {
    preflightSnapshot,
    secretsPrechecked: false,
    authBootstrap: {
      generatedToken: false,
      persistedGeneratedToken: false,
    },
    config: preflightSnapshot.config,
    diagnosticsEnabled: false,
  };
}

/**
 * Startup phase: apply runtime policies derived from resolved startup config.
 */
export async function runGatewayStartupRuntimePolicyPhase(
  deps: GatewayStartupRuntimePolicyDeps,
): Promise<GatewayStartupContext> {
  const diagnosticsEnabled = deps.isDiagnosticsEnabled(deps.context.config);
  if (diagnosticsEnabled) {
    deps.startDiagnosticHeartbeat();
  }

  deps.setGatewaySigusr1RestartPolicy({
    allowExternal: deps.isRestartEnabled(deps.context.config),
  });
  deps.setPreRestartDeferralCheck(deps.getPendingWorkCount);

  return {
    ...deps.context,
    config: await deps.seedControlUiAllowedOrigins(deps.context.config),
    diagnosticsEnabled,
  };
}

/**
 * Startup phase: resolve transport/runtime settings from startup config.
 */
export async function runGatewayStartupRuntimeConfigPhase(
  deps: GatewayStartupRuntimeConfigPhaseDeps,
): Promise<GatewayStartupContext & { runtimeConfig: GatewayRuntimeConfig }> {
  try {
    return {
      ...deps.context,
      runtimeConfig: await deps.resolveRuntimeConfig(deps.context.config),
    };
  } catch (err) {
    throw new GatewayStartupPreflightError(
      "runtime_config_resolution",
      formatStartupPhaseErrorMessage(err, "Failed to resolve gateway runtime config."),
      { cause: err },
    );
  }
}

/**
 * Startup phase: resolve control UI root state from runtime config.
 */
export async function runGatewayStartupControlUiRootPhase(
  deps: GatewayStartupControlUiRootPhaseDeps,
): Promise<
  GatewayStartupContext & {
    runtimeConfig: GatewayRuntimeConfig;
    controlUiRootState: ControlUiRootState | undefined;
  }
> {
  try {
    return {
      ...deps.context,
      controlUiRootState: await deps.resolveControlUiRootState({
        runtimeConfig: deps.context.runtimeConfig,
      }),
    };
  } catch (err) {
    throw new GatewayStartupPreflightError(
      "control_ui_root_resolution",
      formatStartupPhaseErrorMessage(err, "Failed to resolve control UI root."),
      { cause: err },
    );
  }
}
