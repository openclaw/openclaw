import {
  loadAuthProfileStoreForSecretsRuntime,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonNodeBinDir,
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
  warn?: DaemonInstallWarnFn;
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
    const key = normalizeEnvVarKey(ref.id, { portable: true });
    if (!key) {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      params.warn?.(
        `Auth profile env ref "${key}" blocked by host-env security policy`,
        "Auth profile",
      );
      continue;
    }
    const value = params.env[key]?.trim();
    if (!value) {
      continue;
    }
    entries[key] = value;
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

  // Merge env sources in ascending priority:
  //   1. Auth-profile env refs  (shell-only credentials for --secret-input-mode ref flows)
  //   2. Service environment    (HOME, PATH, OPENCLAW_* — highest priority, always wins)
  //
  // Config env vars (openclaw.json env.vars + inline keys) are intentionally excluded —
  // those can contain provider secrets that must never be persisted into service unit metadata.
  return {
    programArguments,
    workingDirectory,
    environment: {
      ...collectAuthProfileServiceEnvVars({
        env: params.env,
        authStore: params.authStore,
        warn: params.warn,
      }),
      ...serviceEnvironment,
    },
  };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install."
    : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
