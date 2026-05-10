import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isContainerEnvironment } from "./net.js";

const EXTRA_CONTROL_UI_ALLOWED_ORIGINS_ENV = "OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  runtimeBind?: unknown;
  runtimePort?: unknown;
}): Promise<{ config: OpenClawConfig; persistedAllowedOriginsSeed: boolean }> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config, {
    isContainerEnvironment,
    runtimeBind: params.runtimeBind,
    runtimePort: params.runtimePort,
  });
  const merged = mergeConfiguredControlUiAllowedOrigins(
    seeded.config,
    parseExtraControlUiAllowedOriginsFromEnv(),
  );
  const shouldPersist =
    Boolean(seeded.seededOrigins && seeded.bind) || merged.addedOrigins.length > 0;
  if (!shouldPersist) {
    return { config: params.config, persistedAllowedOriginsSeed: false };
  }
  try {
    await params.writeConfig(merged.config);
    if (seeded.seededOrigins && seeded.bind) {
      params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
    }
    if (merged.addedOrigins.length > 0) {
      params.log.info(buildMergedOriginsInfoLog(merged.addedOrigins));
    }
    return { config: merged.config, persistedAllowedOriginsSeed: true };
  } catch (err) {
    params.log.warn(
      `gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`,
    );
  }
  return { config: merged.config, persistedAllowedOriginsSeed: false };
}

function parseExtraControlUiAllowedOriginsFromEnv(
  raw = process.env[EXTRA_CONTROL_UI_ALLOWED_ORIGINS_ENV],
): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return normalizeOrigins(parsed);
    }
  } catch {
    // Fall back to a comma/newline-separated list for plain env-var usage.
  }
  return normalizeOrigins(trimmed.split(/[\r\n,]+/));
}

function normalizeOrigins(origins: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const origin of origins) {
    if (typeof origin !== "string") {
      continue;
    }
    const trimmed = origin.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mergeConfiguredControlUiAllowedOrigins(
  config: OpenClawConfig,
  extraOrigins: string[],
): {
  config: OpenClawConfig;
  addedOrigins: string[];
} {
  if (extraOrigins.length === 0) {
    return { config, addedOrigins: [] };
  }
  const currentOrigins = normalizeOrigins(
    Array.isArray(config.gateway?.controlUi?.allowedOrigins)
      ? config.gateway.controlUi.allowedOrigins
      : [],
  );
  const mergedOrigins = normalizeOrigins([...currentOrigins, ...extraOrigins]);
  const addedOrigins = mergedOrigins.filter((origin) => !currentOrigins.includes(origin));
  if (addedOrigins.length === 0) {
    return { config, addedOrigins };
  }
  return {
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: {
          ...config.gateway?.controlUi,
          allowedOrigins: mergedOrigins,
        },
      },
    },
    addedOrigins,
  };
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}

function buildMergedOriginsInfoLog(origins: string[]): string {
  return (
    `gateway: merged gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `from ${EXTRA_CONTROL_UI_ALLOWED_ORIGINS_ENV}.`
  );
}
