import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  loadAuthProfileStoreForSecretsRuntime,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
} from "../infra/host-env-security.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";

/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for embedding in a service
 * environment (LaunchAgent plist, systemd unit, Scheduled Task).
 *
 * Security: dangerous host env vars (NODE_OPTIONS, LD_PRELOAD, etc.) are
 * dropped, matching the same policy applied to config env vars.
 */
export function readStateDirDotEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const dotEnvPath = path.join(stateDir, ".env");

  let content: string;
  try {
    content = fs.readFileSync(dotEnvPath, "utf8");
  } catch {
    return {};
  }

  const parsed = dotenv.parse(content);
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || !value?.trim()) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      continue;
    }
    entries[key] = value;
  }
  return entries;
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

  // Merge env sources into the service environment in ascending priority:
  //   1. ~/.openclaw/.env file vars  (lowest — user secrets / fallback keys)
  //   2. Config env vars              (openclaw.json env.vars + inline keys)
  //   3. Auth-profile env refs        (credential store → env var lookups)
  //   4. Service environment          (HOME, PATH, OPENCLAW_* — highest)
  const environment: Record<string, string | undefined> = {
    ...readStateDirDotEnvVars(params.env),
    ...collectConfigServiceEnvVars(params.config),
    ...collectAuthProfileServiceEnvVars({
      env: params.env,
      authStore: params.authStore,
    }),
  };
  Object.assign(environment, serviceEnvironment);

  return { programArguments, workingDirectory, environment };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
