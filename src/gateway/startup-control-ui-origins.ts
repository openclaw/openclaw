import type { MullusiConfig } from "../config/config.js";
import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: MullusiConfig;
  writeConfig: (config: MullusiConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<{ config: MullusiConfig; persistedAllowedOriginsSeed: boolean }> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config);
  if (!seeded.seededOrigins || !seeded.bind) {
    return { config: params.config, persistedAllowedOriginsSeed: false };
  }
  try {
    await params.writeConfig(seeded.config);
    params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
    return { config: seeded.config, persistedAllowedOriginsSeed: true };
  } catch (err) {
    params.log.warn(
      `gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`,
    );
  }
  return { config: seeded.config, persistedAllowedOriginsSeed: false };
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
