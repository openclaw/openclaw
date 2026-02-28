import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
  loadConfig,
} from "../config/config.js";
import { isLoopbackIpAddress } from "../shared/net/ip.js";
import {
  assertGatewayAuthConfigured,
  type ResolvedGatewayAuth,
  resolveGatewayAuth,
} from "./auth.js";
import { configureUsageReporter } from "./billing/usage-reporter.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { resolveHooksConfig } from "./hooks.js";
import { isLoopbackHost, isValidIPv4, resolveGatewayBindHost } from "./net.js";

export type GatewayRuntimeConfig = {
  bindHost: string;
  controlUiEnabled: boolean;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  controlUiBasePath: string;
  controlUiRoot?: string;
  resolvedAuth: ResolvedGatewayAuth;
  authMode: ResolvedGatewayAuth["mode"];
  tailscaleConfig: GatewayTailscaleConfig;
  tailscaleMode: "off" | "serve" | "funnel";
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  canvasHostEnabled: boolean;
  /** Resolved HSTS header value, or undefined when disabled/unset. */
  strictTransportSecurityHeader?: string;
};

export async function resolveGatewayRuntimeConfig(params: {
  cfg: ReturnType<typeof loadConfig>;
  port: number;
  bind?: GatewayBindMode;
  host?: string;
  controlUiEnabled?: boolean;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
}): Promise<GatewayRuntimeConfig> {
  const bindMode = params.bind ?? params.cfg.gateway?.bind ?? "loopback";
  const customBindHost = params.cfg.gateway?.customBindHost;
  const bindHost = params.host ?? (await resolveGatewayBindHost(bindMode, customBindHost));
  const controlUiEnabled =
    params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
  const openAiChatCompletionsEnabled =
    params.openAiChatCompletionsEnabled ??
    params.cfg.gateway?.http?.endpoints?.chatCompletions?.enabled ??
    false;
  const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
  const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
  const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
  const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
  const controlUiRoot =
    typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0
      ? controlUiRootRaw.trim()
      : undefined;
  const authBase = params.cfg.gateway?.auth ?? {};
  const authOverrides = params.auth ?? {};
  const authConfig = {
    ...authBase,
    ...authOverrides,
  };
  const tailscaleBase = params.cfg.gateway?.tailscale ?? {};
  const tailscaleOverrides = params.tailscale ?? {};
  const tailscaleConfig = {
    ...tailscaleBase,
    ...tailscaleOverrides,
  };
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode,
    cfg: params.cfg,
  });
  const authMode: ResolvedGatewayAuth["mode"] = resolvedAuth.mode;
  const hasToken = typeof resolvedAuth.token === "string" && resolvedAuth.token.trim().length > 0;
  const hasPassword =
    typeof resolvedAuth.password === "string" && resolvedAuth.password.trim().length > 0;
  const hasSharedSecret =
    (authMode === "token" && hasToken) || (authMode === "password" && hasPassword);
  const hooksConfig = resolveHooksConfig(params.cfg);
  const canvasHostEnabled =
    process.env.BOT_SKIP_CANVAS_HOST !== "1" && params.cfg.canvasHost?.enabled !== false;

  const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];

  assertGatewayAuthConfigured(resolvedAuth);

  // Initialize usage reporter for IAM billing
  if (resolvedAuth.mode === "iam" && resolvedAuth.iam) {
    configureUsageReporter(resolvedAuth.iam);
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or BOT_GATEWAY_PASSWORD)",
    );
  }
  if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) {
    throw new Error("tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)");
  }

  // Bind-mode sanity checks (run before auth/origin checks so error messages
  // pinpoint the bind misconfiguration).
  if (bindMode === "loopback" && !isLoopbackHost(bindHost)) {
    throw new Error(
      `gateway bind=loopback resolved to non-loopback host ${bindHost}; check your network configuration`,
    );
  }
  if (bindMode === "custom") {
    if (!customBindHost || customBindHost.trim().length === 0) {
      throw new Error("gateway.bind=custom requires gateway.customBindHost to be set");
    }
    if (!isValidIPv4(customBindHost.trim())) {
      throw new Error(
        `gateway.bind=custom requires a valid IPv4 customBindHost, got "${customBindHost.trim()}"`,
      );
    }
    if (bindHost !== customBindHost.trim()) {
      throw new Error(
        `gateway bind=custom requested ${customBindHost.trim()} but resolved ${bindHost}`,
      );
    }
  }

  if (
    !isLoopbackHost(bindHost) &&
    !hasSharedSecret &&
    authMode !== "trusted-proxy" &&
    authMode !== "iam"
  ) {
    throw new Error(
      `refusing to bind gateway to ${bindHost}:${params.port} without auth (set gateway.auth.token/password, or set BOT_GATEWAY_TOKEN/BOT_GATEWAY_PASSWORD)`,
    );
  }

  if (authMode === "trusted-proxy") {
    if (trustedProxies.length === 0) {
      throw new Error(
        "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      );
    }
    // Loopback binding with trusted-proxy is valid only when at least one
    // trusted proxy is a loopback address (e.g. a local reverse proxy).
    if (isLoopbackHost(bindHost)) {
      const hasLoopbackProxy = trustedProxies.some((proxy) => {
        const bare = proxy.trim();
        // Handle CIDR notation (e.g. 127.0.0.0/8)
        const ip = bare.includes("/") ? bare.split("/")[0] : bare;
        return isLoopbackIpAddress(ip);
      });
      if (!hasLoopbackProxy) {
        throw new Error(
          "gateway auth mode=trusted-proxy with bind=loopback requires gateway.trustedProxies to include 127.0.0.1, ::1, or a loopback CIDR",
        );
      }
    }
  }

  // Non-loopback Control UI requires allowedOrigins to prevent CSRF unless
  // the dangerous Host-header fallback is explicitly enabled.
  if (!isLoopbackHost(bindHost) && controlUiEnabled) {
    const allowedOrigins = params.cfg.gateway?.controlUi?.allowedOrigins;
    const dangerousFallback =
      params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
    if (!dangerousFallback && (!allowedOrigins || allowedOrigins.length === 0)) {
      throw new Error(
        "non-loopback Control UI requires gateway.controlUi.allowedOrigins to be configured",
      );
    }
  }

  // Resolve HSTS header from config.
  const stsRaw = params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
  const strictTransportSecurityHeader =
    stsRaw === false || stsRaw === undefined || stsRaw === null
      ? undefined
      : typeof stsRaw === "string" && stsRaw.trim().length > 0
        ? stsRaw.trim()
        : undefined;

  return {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig: openResponsesConfig
      ? { ...openResponsesConfig, enabled: openResponsesEnabled }
      : undefined,
    controlUiBasePath,
    controlUiRoot,
    resolvedAuth,
    authMode,
    tailscaleConfig,
    tailscaleMode,
    hooksConfig,
    canvasHostEnabled,
    strictTransportSecurityHeader,
  };
}
