import type { GatewayBindMode, OpenClawConfig } from "../config/config.js";
import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** CLI-resolved bind mode; takes precedence over config.gateway.bind. */
  bindOverride?: GatewayBindMode;
}): Promise<OpenClawConfig> {
  // Apply the CLI bind override so the seeding function sees the effective bind
  // mode even when it was not persisted to the config file (e.g. --bind lan in
  // Docker/Railway).
  const effectiveConfig =
    params.bindOverride && params.bindOverride !== params.config.gateway?.bind
      ? {
          ...params.config,
          gateway: { ...params.config.gateway, bind: params.bindOverride },
        }
      : params.config;
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(effectiveConfig);
  if (!seeded.seededOrigins || !seeded.bind) {
    return params.config;
  }
  // Apply the seeded origins to the *original* config (not effectiveConfig) so
  // we don't accidentally persist the CLI bind override into the config file.
  const resultConfig: OpenClawConfig = {
    ...params.config,
    gateway: {
      ...params.config.gateway,
      controlUi: {
        ...params.config.gateway?.controlUi,
        allowedOrigins: seeded.seededOrigins,
      },
    },
  };
  try {
    await params.writeConfig(resultConfig);
    params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
  } catch (err) {
    params.log.warn(
      `gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`,
    );
  }
  return resultConfig;
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
