import { formatCliCommand } from "../cli/command-format.js";
import {
  migrateLegacyConfig,
  type ConfigFileSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";

export type GatewayStartupPreflightPhase =
  | "config_legacy_migration"
  | "config_validation"
  | "plugin_auto_enable";

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
): Promise<ConfigFileSnapshot> {
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
    return configSnapshot;
  }

  try {
    await deps.writeConfig(autoEnable.config);
    deps.log.info(
      `gateway: auto-enabled plugins:\n${autoEnable.changes
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    );
    return await deps.readSnapshot();
  } catch (err) {
    deps.log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
    return configSnapshot;
  }
}

type GatewayStartupSecretsPrecheckDeps = {
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

/**
 * Startup phase: fail-fast secrets precheck before runtime boot.
 */
export async function runGatewayStartupSecretsPrecheck(
  deps: GatewayStartupSecretsPrecheckDeps,
): Promise<void> {
  const freshSnapshot = await deps.readSnapshot();
  if (!freshSnapshot.valid) {
    throw new GatewayStartupPreflightError(
      "config_validation",
      buildInvalidConfigMessageForStartupSecretPrecheck(freshSnapshot),
    );
  }
  const startupPreflightConfig = deps.prepareConfig(freshSnapshot.config);
  await deps.activateRuntimeSecrets(startupPreflightConfig);
}

/**
 * Startup phase: resolve gateway auth and activate runtime secrets.
 */
export async function runGatewayStartupAuthBootstrap(
  deps: GatewayStartupAuthBootstrapDeps,
): Promise<OpenClawConfig> {
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

  return (await deps.activateRuntimeSecrets(cfgAtStart)).config;
}
