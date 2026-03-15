import {
  loadAuthProfileStoreForSecretsRuntime,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { collectEnvVarReferences } from "../config/env-substitution.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import type { OpenClawConfig } from "../config/types.js";
import { isSecretRef } from "../config/types.secrets.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectEnvBackedSecretRefIds(value: unknown, refs: Set<string>): void {
  if (isSecretRef(value)) {
    if (value.source === "env") {
      refs.add(value.id);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectEnvBackedSecretRefIds(entry, refs);
    }
    return;
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectEnvBackedSecretRefIds(entry, refs);
    }
  }
}

function collectReferencedServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  value: unknown;
}): Record<string, string> {
  const entries: Record<string, string> = {};
  const refs = new Set<string>(collectEnvVarReferences(params.value));
  collectEnvBackedSecretRefIds(params.value, refs);

  for (const refId of refs) {
    const value = params.env[refId]?.trim();
    if (!value) {
      continue;
    }
    entries[refId] = value;
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
  const authStore = params.authStore ?? loadAuthProfileStoreForSecretsRuntime();

  // Merge config env vars into the service environment (vars + inline env keys).
  // Config env vars are added first so service-specific vars take precedence.
  const environment: Record<string, string | undefined> = {
    ...collectConfigServiceEnvVars(params.config),
    ...collectReferencedServiceEnvVars({
      env: params.env,
      value: params.config,
    }),
    ...collectReferencedServiceEnvVars({
      env: params.env,
      value: authStore,
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
