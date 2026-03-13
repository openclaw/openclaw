import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayStateDir } from "../daemon/paths.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export { resolveGatewayDevMode } from "./daemon-install-plan.shared.js";

export type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
  /** Full config to extract env vars from (env vars + inline env keys). */
  config?: OpenClawConfig;
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
  });

  // Merge config env vars into the service environment (vars + inline env keys).
  // Config env vars are added first so service-specific vars take precedence.
  const environment: Record<string, string | undefined> = {
    ...collectConfigServiceEnvVars(params.config),
  };
  Object.assign(environment, serviceEnvironment);

  // Default working directory to the OpenClaw state dir (e.g. ~/.openclaw) so the
  // daemon does not run with `/` as cwd when launched by launchd/systemd.
  const resolvedWorkingDirectory = workingDirectory ?? resolveGatewayStateDir(params.env);
  // Ensure the working directory exists so launchd/systemd can CHDIR into it on first install.
  fs.mkdirSync(resolvedWorkingDirectory, { recursive: true, mode: 0o700 });

  return { programArguments, workingDirectory: resolvedWorkingDirectory, environment };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: rerun from an elevated PowerShell (Start → type PowerShell → right-click → Run as administrator) or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
