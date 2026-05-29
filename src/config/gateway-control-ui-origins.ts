import { DEFAULT_GATEWAY_PORT } from "./paths.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type GatewayNonLoopbackBindMode = "lan" | "tailnet" | "custom" | "auto";

export function isGatewayNonLoopbackBindMode(bind: unknown): bind is GatewayNonLoopbackBindMode {
  return bind === "lan" || bind === "tailnet" || bind === "custom" || bind === "auto";
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

export function buildDefaultControlUiAllowedOrigins(params: {
  port: number;
  bind: unknown;
  customBindHost?: string;
}): string[] {
  // Safe automatic defaults are loopback-only.  Non-loopback gateway binds still
  // need CORS protection, but LAN/tailnet/custom browser origins must be
  // configured explicitly by the operator instead of inferred from bind mode.
  return [
    `http://localhost:${params.port}`,
    `http://127.0.0.1:${params.port}`,
  ];
}

export function ensureControlUiAllowedOriginsForNonLoopbackBind(
  config: OpenClawConfig,
  opts?: {
    defaultPort?: number;
    requireControlUiEnabled?: boolean;
    // Resolved runtime bind override. Mirrors Gateway runtime precedence:
    // explicit CLI/runtime bind wins over gateway.bind.
    runtimeBind?: unknown;
    // Resolved runtime port override. Mirrors Gateway runtime precedence:
    // explicit CLI/runtime port wins over gateway.port.
    runtimePort?: unknown;
    // Optional container-detection callback.  When provided and `gateway.bind`
    // is unset, the function is called to determine whether the runtime will
    // choose the container-friendly bind mode so loopback Control UI origins
    // can be prepared proactively.  Keeping this as an injected callback avoids
    // a hard dependency from the config layer on the gateway runtime layer.
    isContainerEnvironment?: () => boolean;
  },
): {
  config: OpenClawConfig;
  seededOrigins: string[] | null;
  bind: GatewayNonLoopbackBindMode | null;
} {
  const bind = opts?.runtimeBind ?? config.gateway?.bind;
  // When bind is unset and the process is containerized, the runtime chooses
  // the container-friendly bind mode.  Prepare loopback Control UI origins here
  // so startup keeps a concrete CORS allowlist without granting remote browser
  // origins implicitly.
  const effectiveBind: typeof bind =
    bind ?? (opts?.isContainerEnvironment?.() ? "auto" : undefined);
  if (!isGatewayNonLoopbackBindMode(effectiveBind)) {
    return { config, seededOrigins: null, bind: null };
  }
  if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) {
    return { config, seededOrigins: null, bind: effectiveBind };
  }
  if (
    hasConfiguredControlUiAllowedOrigins({
      allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
      dangerouslyAllowHostHeaderOriginFallback:
        config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    })
  ) {
    return { config, seededOrigins: null, bind: effectiveBind };
  }

  const port = resolveGatewayPortWithDefault(
    opts?.runtimePort ?? config.gateway?.port,
    opts?.defaultPort,
  );
  const seededOrigins = buildDefaultControlUiAllowedOrigins({
    port,
    bind: effectiveBind,
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
    bind: effectiveBind,
  };
}
