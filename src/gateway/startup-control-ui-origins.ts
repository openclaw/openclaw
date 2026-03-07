import type { OpenClawConfig } from "../config/config.js";
import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import type { GatewayBindMode } from "../config/types.gateway.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** CLI --bind override; merged into config before checking origins. */
  bind?: string;
}): Promise<OpenClawConfig> {
  // Merge CLI bind override so --bind lan (without config-file entry) is
  // recognised before the first resolveGatewayRuntimeConfig call.
  const configForSeed =
    params.bind && !params.config.gateway?.bind
      ? {
          ...params.config,
          gateway: { ...params.config.gateway, bind: params.bind as GatewayBindMode },
        }
      : params.config;
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(configForSeed);
  if (!seeded.seededOrigins || !seeded.bind) {
    return params.config;
  }
  try {
    await params.writeConfig(seeded.config);
    params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
  } catch (err) {
    params.log.warn(
      `gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`,
    );
  }
  return seeded.config;
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
