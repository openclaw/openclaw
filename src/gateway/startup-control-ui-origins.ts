import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isContainerEnvironment } from "./net.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  runtimeBind?: unknown;
  runtimePort?: unknown;
}): Promise<{ config: OpenClawConfig; seededAllowedOrigins: boolean }> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config, {
    isContainerEnvironment,
    runtimeBind: params.runtimeBind,
    runtimePort: params.runtimePort,
  });
  const tailnetSeeded = await maybeSeedTailnetControlUiOrigin({
    config: seeded.config,
    log: params.log,
  });
  if (!seeded.seededOrigins || !seeded.bind) {
    return {
      config: tailnetSeeded.config,
      seededAllowedOrigins: tailnetSeeded.seededAllowedOrigins,
    };
  }
  params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
  return { config: tailnetSeeded.config, seededAllowedOrigins: true };
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Applied for this runtime without writing config; add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}

async function maybeSeedTailnetControlUiOrigin(params: {
  config: OpenClawConfig;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<{ config: OpenClawConfig; seededAllowedOrigins: boolean }> {
  const tailscale = params.config.gateway?.tailscale;
  if (tailscale?.mode !== "serve" && tailscale?.mode !== "funnel") {
    return { config: params.config, seededAllowedOrigins: false };
  }

  const host = await getTailnetHostname(undefined, {
    binaryPath: tailscale.binaryPath,
    socketPath: tailscale.socketPath,
  }).catch((err) => {
    params.log.warn(`gateway: could not resolve Tailscale Control UI origin: ${String(err)}`);
    return null;
  });
  if (!host) {
    return { config: params.config, seededAllowedOrigins: false };
  }

  const origin = buildTailnetHttpsOrigin(host);
  const existing = params.config.gateway?.controlUi?.allowedOrigins ?? [];
  const normalized = normalizeLowercaseStringOrEmpty(origin);
  if (existing.some((entry) => normalizeLowercaseStringOrEmpty(entry) === normalized)) {
    return { config: params.config, seededAllowedOrigins: false };
  }

  params.log.info(`gateway: added active Tailscale Control UI origin ${origin} for this runtime.`);
  return {
    config: {
      ...params.config,
      gateway: {
        ...params.config.gateway,
        controlUi: {
          ...params.config.gateway?.controlUi,
          allowedOrigins: [...existing, origin],
        },
      },
    },
    seededAllowedOrigins: true,
  };
}

function buildTailnetHttpsOrigin(host: string): string {
  const trimmed = host.trim().replace(/\.$/, "");
  const hostname = trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
  return `https://${hostname}`;
}
