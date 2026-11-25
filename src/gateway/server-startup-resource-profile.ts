import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  predictGatewayResourceProfile,
  type GatewayResourceProfile,
  type ResourceProfile,
} from "../infra/gateway-resource-profile.js";
import type { GatewayServerOptions } from "./server-public.js";

function isConfiguredProfile(value: unknown): value is GatewayResourceProfile["configured"] {
  return value === "auto" || value === "standard" || value === "lean";
}

async function readStartupSourceConfig(): Promise<OpenClawConfig> {
  const [{ createConfigIO }, { cloneEnvWithPlatformSemantics }, { loadDotEnv }] = await Promise.all(
    [
      import("../config/io.js"),
      import("../config/config-env-vars.js"),
      import("../infra/dotenv.js"),
    ],
  );
  // Bootstrap reads the authoritative snapshot later and applies dotenv to process env.
  // Resolve the same dotenv values here without changing process env.
  const env = cloneEnvWithPlatformSemantics(process.env);
  loadDotEnv({ env });
  return await createConfigIO({ env, observe: false }).readSourceConfigBestEffort();
}

/**
 * The profile bootstrap will resolve for this start, for owners that start before it.
 * In-process restarts and direct callers bring no CLI snapshot, so read the config file.
 */
export async function predictGatewayStartupResourceProfile(
  startupConfigSnapshotRead: GatewayServerOptions["startupConfigSnapshotRead"],
  readSourceConfig: () => Promise<OpenClawConfig> = readStartupSourceConfig,
): Promise<ResourceProfile> {
  const config = startupConfigSnapshotRead
    ? startupConfigSnapshotRead.snapshot.config
    : await readSourceConfig().catch(() => undefined);
  const configured: unknown = config?.gateway?.resources?.profile;
  return predictGatewayResourceProfile(isConfiguredProfile(configured) ? configured : undefined);
}
