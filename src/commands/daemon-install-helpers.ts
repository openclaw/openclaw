import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

export function resolveGatewayDevMode(argv: string[] = process.argv): boolean {
  const entry = argv[1];
  const normalizedEntry = entry?.replaceAll("\\", "/");
  return Boolean(normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts"));
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  token?: string;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
  /** Full config to extract env vars from (env vars + inline env keys). */
  config?: OpenClawConfig;
}): Promise<GatewayInstallPlan> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const nodePath =
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  const { programArguments: defaultProgramArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port: params.port,
      dev: devMode,
      runtime: params.runtime,
      nodePath,
    });
  await emitNodeRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    nodeProgram: defaultProgramArguments[0],
    warn: params.warn,
    title: "Gateway runtime",
  });

  // Extract entry.js path from the resolved args (the arg immediately before "gateway").
  // Guard: when a non-Node runtime (e.g. Bun) runs without a separate entry script,
  // programArguments is [execPath, "gateway", ...] — the arg before "gateway" would be
  // the runtime binary, not a JS entrypoint. Only use it if it looks like a script file.
  const gatewayIdx = defaultProgramArguments.indexOf("gateway");
  const candidateEntry = gatewayIdx > 0 ? defaultProgramArguments[gatewayIdx - 1] : undefined;
  const entryPath =
    candidateEntry && /\.(js|mjs|cjs|ts|mts)$/.test(candidateEntry) ? candidateEntry : undefined;

  const serviceEnvironment = buildServiceEnvironment({
    env: params.env,
    port: params.port,
    token: params.token,
    entryPath,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(params.env.OPENCLAW_PROFILE)
        : undefined,
  });

  // Merge config env vars into the service environment (vars + inline env keys).
  // Config env vars are added first so service-specific vars take precedence.
  const environment: Record<string, string | undefined> = {
    ...collectConfigServiceEnvVars(params.config),
  };
  Object.assign(environment, serviceEnvironment);

  // Check for a custom launcher script in config.
  const launcherRaw = params.config?.gateway?.service?.launcher;
  let programArguments = defaultProgramArguments;
  if (launcherRaw) {
    const resolvedLauncher = resolveLauncherPath(launcherRaw);
    validateLauncherScript(resolvedLauncher);
    programArguments = [resolvedLauncher];
  }

  return { programArguments, workingDirectory, environment };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: rerun from an elevated PowerShell (Start → type PowerShell → right-click → Run as administrator) or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}

/** Resolve a launcher path, expanding leading `~/` or `~\` to the user's home directory. */
function resolveLauncherPath(raw: string): string {
  const expanded =
    raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(os.homedir(), raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`gateway.service.launcher: path must be absolute or start with ~/: ${raw}`);
  }
  return expanded;
}

/** Validate that the launcher script exists and is executable. Throws on failure. */
function validateLauncherScript(resolvedPath: string): void {
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`gateway.service.launcher: script not found: ${resolvedPath}`);
  }
  try {
    fs.accessSync(resolvedPath, fs.constants.X_OK);
  } catch {
    throw new Error(
      `gateway.service.launcher: script is not executable: ${resolvedPath}\nRun: chmod +x ${resolvedPath}`,
    );
  }
}
