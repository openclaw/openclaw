import fs from "node:fs";
import path from "node:path";
import {
  loadAuthProfileStoreForSecretsRuntime,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { resolveConfigDir } from "../utils.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";

/**
 * Load environment variables from ~/.openclaw/.env file.
 * This is needed because launchd services do not inherit shell environment,
 * so API keys stored in .env are not available to the Gateway LaunchAgent.
 */
function loadDotEnvFile(env: Record<string, string | undefined>): Record<string, string> {
  const configDir = resolveConfigDir(env);
  const envFilePath = path.join(configDir, ".env");

  if (!fs.existsSync(envFilePath)) {
    return {};
  }

  const content = fs.readFileSync(envFilePath, "utf8");
  const envVars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Parse KEY=VALUE or KEY="value" or KEY='value'
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      envVars[key] = value;
    }
  }

  return envVars;
}

export type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

function collectAuthProfileServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  authStore?: AuthProfileStore;
}): Record<string, string> {
  const authStore = params.authStore ?? loadAuthProfileStoreForSecretsRuntime();
  const entries: Record<string, string> = {};

  for (const credential of Object.values(authStore.profiles)) {
    const ref =
      credential.type === "api_key"
        ? credential.keyRef
        : credential.type === "token"
          ? credential.tokenRef
          : undefined;
    if (!ref || ref.source !== "env") {
      continue;
    }
    const value = params.env[ref.id]?.trim();
    if (!value) {
      continue;
    }
    entries[ref.id] = value;
  }

  return entries;
}

function buildGatewayInstallEnvironment(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
  serviceEnvironment: Record<string, string | undefined>;
}): Record<string, string | undefined> {
  // Merge env sources into the service environment in ascending priority:
  //   1. ~/.openclaw/.env file vars  (lowest — user secrets / fallback keys)
  //   2. Config env vars              (openclaw.json env.vars + inline keys)
  //   3. Auth-profile env refs        (credential store → env var lookups)
  //   4. Service environment          (HOME, PATH, OPENCLAW_* — highest)

  // Load .env file variables from ~/.openclaw/.env
  const dotEnvVars = loadDotEnvFile(params.env);

  const environment: Record<string, string | undefined> = {
    ...dotEnvVars,
    ...collectDurableServiceEnvVars({
      env: params.env,
      config: params.config,
    }),
    ...collectAuthProfileServiceEnvVars({
      env: params.env,
      authStore: params.authStore,
    }),
  };
  Object.assign(environment, params.serviceEnvironment);
  return environment;
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
  /** Full config to extract env vars from (env vars + inline env keys). */
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): Promise<GatewayInstallPlan> {
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.port,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });
  await emitDaemonInstallRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Gateway runtime",
  });
  const serviceEnvironment = buildServiceEnvironment({
    env: params.env,
    port: params.port,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(params.env.OPENCLAW_PROFILE)
        : undefined,
    // Keep npm/pnpm available to the service when the selected daemon node comes from
    // a version-manager bin directory that isn't covered by static PATH guesses.
    extraPathDirs: resolveDaemonNodeBinDir(nodePath),
  });

  return {
    programArguments,
    workingDirectory,
    environment: buildGatewayInstallEnvironment({
      env: params.env,
      config: params.config,
      authStore: params.authStore,
      serviceEnvironment,
    }),
  };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
