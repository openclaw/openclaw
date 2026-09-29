// Gateway connection detail builder for CLI/user-facing target diagnostics.
import { createHash } from "node:crypto";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { resolveConfigPath, resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { isLoopbackHost, isSecureWebSocketUrl } from "./net.js";

export type GatewaySshRoute = {
  target: string;
  remotePort: number;
  identity?: string;
  hostKeyPolicy?: "strict" | "openssh";
};

/** Resolve the forwarded Gateway port independently of the local tunnel port. */
export function resolveGatewaySshRemotePort(
  config: OpenClawConfig,
  gatewayUrl = config.gateway?.remote?.url,
): number {
  if (config.gateway?.remote?.remotePort !== undefined) {
    return config.gateway.remote.remotePort;
  }
  const url = gatewayUrl?.trim();
  if (url && URL.canParse(url)) {
    // A non-default scheme preserves explicit :80/:443 that WHATWG strips
    // from ws/wss URLs; a missing port still falls back to gateway.port.
    const port = new URL(url.replace(/^wss?:/iu, "openclaw-ssh:")).port;
    if (port) {
      return Number(port);
    }
  }
  return resolveGatewayPort(config);
}

/** Select credential ownership independently of an SSH tunnel's reusable local port. */
export function resolveGatewayDeviceAuthRoute(params: {
  config: OpenClawConfig;
  url: string;
  remote: boolean;
  configuredRemote?: boolean;
  tlsFingerprint?: string;
  sshRoute?: GatewaySshRoute;
}): { deviceAuthScope?: string; sshTunnel?: GatewaySshRoute; bound: boolean } {
  if (!params.remote) {
    return { bound: false };
  }
  const url = params.url.trim();
  const deviceAuthScope = gatewayOriginScope(url);
  if (!URL.canParse(url)) {
    return { deviceAuthScope, bound: false };
  }
  const parsed = new URL(url);
  if (!isLoopbackHost(parsed.hostname)) {
    return { deviceAuthScope, bound: true };
  }
  const remote = params.config.gateway?.remote;
  const configuredTarget = normalizeOptionalString(remote?.sshTarget);
  const identity = normalizeOptionalString(remote?.sshIdentity);
  const configuredSshRoute =
    params.configuredRemote &&
    configuredTarget &&
    remote?.transport !== "direct" &&
    remote?.url?.trim() === url
      ? {
          target: configuredTarget,
          remotePort: resolveGatewaySshRemotePort(params.config, url),
          ...(identity ? { identity } : {}),
          ...(remote.sshHostKeyPolicy ? { hostKeyPolicy: remote.sshHostKeyPolicy } : {}),
        }
      : undefined;
  const sshRoute = params.sshRoute ?? configuredSshRoute;
  if (sshRoute) {
    const sshTunnel = { ...sshRoute, target: sshRoute.target.trim() };
    // Match native selected-route ownership. The client must own this SSH
    // transport; the selected alias alone does not authenticate a local listener.
    const route = `${sshTunnel.target}:gateway-port:${sshTunnel.remotePort}`;
    return {
      deviceAuthScope: `remote:ssh:${createHash("sha256").update(route).digest("hex")}`,
      sshTunnel,
      bound: true,
    };
  }
  const fingerprint = normalizeTlsFingerprint(params.tlsFingerprint);
  if (parsed.protocol === "wss:" && fingerprint) {
    return {
      deviceAuthScope: `remote:tls:${createHash("sha256")
        .update(`${deviceAuthScope}:tls-sha256:${fingerprint}`)
        .digest("hex")}`,
      bound: true,
    };
  }
  return { deviceAuthScope, bound: false };
}

/** Resolved gateway target plus redacted display text for diagnostics. */
export type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

/** Project raw transport details into the credential-safe CLI/report shape. */
export function projectGatewayConnectionDetailsForDiagnostics(
  details: GatewayConnectionDetails,
): GatewayConnectionDetails {
  return {
    ...details,
    url: redactSensitiveUrlLikeString(details.url),
    message: redactSensitiveUrlLikeString(details.message),
  };
}

/** Redact one Gateway URL before it crosses an operator-visible diagnostic boundary. */
export function projectGatewayUrlForDiagnostics(url: string): string {
  return redactSensitiveUrlLikeString(url);
}

type GatewayConnectionDetailResolvers = {
  getRuntimeConfig?: () => OpenClawConfig;
  resolveConfigPath?: (env: NodeJS.ProcessEnv) => string;
  resolveGatewayPort?: (cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv) => number;
};

/** Build gateway target details and reject unsafe remote plaintext websocket URLs. */
export function buildGatewayConnectionDetailsWithResolvers(
  options: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
    ignoreEnvUrlOverride?: boolean;
    localPortOverride?: number;
    serviceTargetUrl?: string;
  } = {},
  resolvers: GatewayConnectionDetailResolvers = {},
): GatewayConnectionDetails {
  const config = options.config ?? resolvers.getRuntimeConfig?.() ?? {};
  const configPath =
    options.configPath ??
    resolvers.resolveConfigPath?.(process.env) ??
    resolveConfigPath(process.env);
  const isRemoteMode = options.localPortOverride === undefined && config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort =
    options.localPortOverride ??
    resolvers.resolveGatewayPort?.(config, process.env) ??
    resolveGatewayPort(config);
  const bindMode = config.gateway?.bind ?? "loopback";
  const scheme = tlsEnabled ? "wss" : "ws";
  const localUrl = `${scheme}://127.0.0.1:${localPort}`;
  const cliUrlOverride = normalizeOptionalString(options.url);
  const serviceUrl = normalizeOptionalString(options.serviceTargetUrl);
  const envUrlOverride =
    cliUrlOverride ||
    serviceUrl ||
    options.ignoreEnvUrlOverride ||
    options.localPortOverride !== undefined
      ? undefined
      : normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const remoteUrl = normalizeOptionalString(remote?.url);
  const remoteMisconfigured = isRemoteMode && !urlOverride && !serviceUrl && !remoteUrl;
  const urlSourceHint =
    options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined);
  const url = urlOverride || serviceUrl || remoteUrl || localUrl;
  const displayUrl = redactSensitiveUrlLikeString(url);
  const urlSource = urlOverride
    ? urlSourceHint === "env"
      ? "env OPENCLAW_GATEWAY_URL"
      : "cli --url"
    : serviceUrl
      ? "service target"
      : remoteUrl
        ? "config gateway.remote.url"
        : remoteMisconfigured
          ? "missing gateway.remote.url (fallback local)"
          : "local loopback";
  const bindDetail = !urlOverride && (serviceUrl || !remoteUrl) ? `Bind: ${bindMode}` : undefined;
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;

  const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
  if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
    throw new Error(
      [
        `SECURITY ERROR: Gateway URL "${displayUrl}" uses plaintext ws:// to a non-loopback address.`,
        "Both credentials and chat data would be exposed to network interception.",
        `Source: ${urlSource}`,
        `Config: ${configPath}`,
        "Fix: Use wss:// for remote gateway URLs.",
        "Safe remote access defaults:",
        "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
        "- or use Tailscale Serve/Funnel for HTTPS remote access",
        allowPrivateWs
          ? undefined
          : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
        "Doctor: openclaw doctor --fix",
        "Docs: https://docs.openclaw.ai/gateway/remote",
      ].join("\n"),
    );
  }

  const message = [
    `Gateway target: ${displayUrl}`,
    `Source: ${urlSource}`,
    `Config: ${configPath}`,
    bindDetail,
    remoteFallbackNote,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    urlSource,
    bindDetail,
    remoteFallbackNote,
    message,
  };
}
