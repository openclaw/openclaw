import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maybeRepairGatewayServiceConfig } from "./commands/doctor-gateway-services.js";
import type { DoctorPrompter } from "./commands/doctor-prompter.js";
import { readBestEffortConfig, type OpenClawConfig } from "./config/config.js";
import type { RuntimeEnv } from "./runtime.js";

export const DEFAULT_GATEWAY_LAUNCH_AGENT_PLIST = "ai.openclaw.gateway.plist";

function resolveLaunchAgentsDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, "Library", "LaunchAgents");
}

export function shouldRunPostinstallGatewayServiceRepair(params: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  launchAgentFiles?: readonly string[];
}): boolean {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  if ((params.platform ?? process.platform) !== "darwin") {
    return false;
  }
  if (env.OPENCLAW_SKIP_POSTINSTALL_GATEWAY_REPAIR === "1") {
    return false;
  }
  if (env.npm_config_global !== "true") {
    return false;
  }
  return Boolean(params.launchAgentFiles?.includes(DEFAULT_GATEWAY_LAUNCH_AGENT_PLIST));
}

function createPostinstallRuntime(): RuntimeEnv {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.warn("[openclaw postinstall]", ...args),
    exit: (_code: number) => {
      throw new Error("postinstall repair must not call runtime.exit()");
    },
  };
}

function createPostinstallPrompter(): DoctorPrompter {
  return {
    confirm: async () => false,
    confirmRepair: async () => true,
    confirmAggressive: async () => false,
    confirmSkipInNonInteractive: async () => false,
    select: async <T>(_params: Parameters<DoctorPrompter["select"]>[0], fallback: T) => fallback,
    shouldRepair: true,
    shouldForce: false,
  };
}

export async function runPostinstallGatewayServiceRepair(params?: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  runtime?: RuntimeEnv;
}): Promise<boolean> {
  const env = params?.env ?? (process.env as Record<string, string | undefined>);
  const launchAgentsDir = resolveLaunchAgentsDir(env);
  let launchAgentFiles: string[] = [];
  try {
    launchAgentFiles = await fs.readdir(launchAgentsDir);
  } catch {
    return false;
  }

  if (
    !shouldRunPostinstallGatewayServiceRepair({
      platform: params?.platform,
      env,
      launchAgentFiles,
    })
  ) {
    return false;
  }

  const runtime = params?.runtime ?? createPostinstallRuntime();
  const config =
    (await readBestEffortConfig().catch(() => undefined)) ??
    ({
      gateway: {},
    } satisfies OpenClawConfig);

  try {
    await maybeRepairGatewayServiceConfig(
      config,
      config.gateway?.mode === "remote" ? "remote" : "local",
      runtime,
      createPostinstallPrompter(),
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    runtime.error(`LaunchAgent repair skipped: ${detail}`);
    return false;
  }
}
