import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isContainerEnvironment } from "./net.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  /** Loaded startup config before runtime-only Control UI origin seeding. */
  config: OpenClawConfig;
  /** Startup logger used when runtime origins are seeded. */
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Runtime bind override used to decide whether loopback protections apply. */
  runtimeBind?: unknown;
  /** Runtime port override used when constructing seeded origins. */
  runtimePort?: unknown;
}): Promise<{ config: OpenClawConfig; seededAllowedOrigins: boolean }> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config, {
    isContainerEnvironment,
    runtimeBind: params.runtimeBind,
    runtimePort: params.runtimePort,
  });
  if (!seeded.seededOrigins || !seeded.bind) {
    return { config: params.config, seededAllowedOrigins: false };
  }
  params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
  return { config: seeded.config, seededAllowedOrigins: true };
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Applied for this runtime without writing config; add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
