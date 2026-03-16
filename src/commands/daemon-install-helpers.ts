import {
  loadAuthProfileStoreForSecretsRuntime,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
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
  });

  // Merge config env vars into the service environment (vars + inline env keys).
  // Config env vars are added first so service-specific vars take precedence.
  const environment: Record<string, string | undefined> = {
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
    ? "提示：当 Scheduled Task 创建被拒绝时，原生 Windows 现在会回退到当前用户的启动文件夹登录项；如果安装仍然失败，请使用提升权限的 PowerShell 重试，或跳过服务安装。"
    : `提示：修复错误后，重新运行 \`${formatCliCommand("openclaw gateway install")}\`。`;
}
