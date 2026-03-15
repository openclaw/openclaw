import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "../shared/net/ip.js";
import type { OpenClawConfig } from "./config.js";
import { DEFAULT_GATEWAY_PORT } from "./paths.js";

export type GatewayNonLoopbackBindMode = "lan" | "tailnet" | "custom";

export function isGatewayNonLoopbackBindMode(bind: unknown): bind is GatewayNonLoopbackBindMode {
  return bind === "lan" || bind === "tailnet" || bind === "custom";
}

export function hasConfiguredControlUiAllowedOrigins(params: {
  allowedOrigins: unknown;
  dangerouslyAllowHostHeaderOriginFallback: unknown;
}): boolean {
  if (params.dangerouslyAllowHostHeaderOriginFallback === true) {
    return true;
  }
  return (
    Array.isArray(params.allowedOrigins) &&
    params.allowedOrigins.some((origin) => typeof origin === "string" && origin.trim().length > 0)
  );
}

export function resolveGatewayPortWithDefault(
  port: unknown,
  fallback = DEFAULT_GATEWAY_PORT,
): number {
  return typeof port === "number" && port > 0 ? port : fallback;
}

export function doesGatewayBindResolveToLoopback(params: {
  bind: unknown;
  customBindHost?: unknown;
}): boolean {
  const bind = params.bind ?? "loopback";
  if (bind === "loopback") {
    return true;
  }
  const customBindHost =
    typeof params.customBindHost === "string" ? params.customBindHost : undefined;
  return (
    bind === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  );
}

export function hasTailscaleServeFunnelNonLoopbackBind(params: {
  bind: unknown;
  customBindHost?: unknown;
  tailscaleMode?: unknown;
}): boolean {
  const { tailscaleMode } = params;
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return false;
  }
  if (!isGatewayNonLoopbackBindMode(params.bind)) {
    return false;
  }
  return !doesGatewayBindResolveToLoopback({
    bind: params.bind,
    customBindHost: params.customBindHost,
  });
}

export function buildDefaultControlUiAllowedOrigins(params: {
  port: number;
  bind: unknown;
  customBindHost?: string;
}): string[] {
  const origins = new Set<string>([
    `http://localhost:${params.port}`,
    `http://127.0.0.1:${params.port}`,
  ]);
  const customBindHost = params.customBindHost?.trim();
  if (params.bind === "custom" && customBindHost) {
    origins.add(`http://${customBindHost}:${params.port}`);
  }
  return [...origins];
}

export function ensureControlUiAllowedOriginsForNonLoopbackBind(
  config: OpenClawConfig,
  opts?: { defaultPort?: number; requireControlUiEnabled?: boolean },
): {
  config: OpenClawConfig;
  seededOrigins: string[] | null;
  bind: GatewayNonLoopbackBindMode | null;
} {
  const bind = config.gateway?.bind;
  if (!isGatewayNonLoopbackBindMode(bind)) {
    return { config, seededOrigins: null, bind: null };
  }
  if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) {
    return { config, seededOrigins: null, bind };
  }
  if (
    hasConfiguredControlUiAllowedOrigins({
      allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
      dangerouslyAllowHostHeaderOriginFallback:
        config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    })
  ) {
    return { config, seededOrigins: null, bind };
  }

  const port = resolveGatewayPortWithDefault(config.gateway?.port, opts?.defaultPort);
  const seededOrigins = buildDefaultControlUiAllowedOrigins({
    port,
    bind,
    customBindHost: config.gateway?.customBindHost,
  });
  return {
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: {
          ...config.gateway?.controlUi,
          allowedOrigins: seededOrigins,
        },
      },
    },
    seededOrigins,
    bind,
  };
}
