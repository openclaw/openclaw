import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  predictGatewayResourceProfile,
  type GatewayResourceProfile,
  type ResourceProfile,
} from "../infra/gateway-resource-profile.js";
import type { GatewayServerOptions } from "./server-public.js";

const CONFIGURED_PROFILES: ReadonlySet<unknown> = new Set(["auto", "standard", "lean"]);

async function readStartupSourceConfig(): Promise<OpenClawConfig> {
  const [{ createConfigIO }, { cloneEnvWithPlatformSemantics }] = await Promise.all([
    import("../config/io.js"),
    import("../config/config-env-vars.js"),
  ]);
  // Bootstrap reads the authoritative snapshot later; this read must not change process env.
  return await createConfigIO({
    env: cloneEnvWithPlatformSemantics(process.env),
    observe: false,
  }).readSourceConfigBestEffort();
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
  return predictGatewayResourceProfile(
    CONFIGURED_PROFILES.has(configured)
      ? (configured as GatewayResourceProfile["configured"])
      : undefined,
  );
}
