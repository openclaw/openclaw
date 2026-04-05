import { resolveConfigPath, resolveGatewayPort } from "../config/paths.js";
import type { MullusiConfig } from "../config/types.js";
import { isSecureWebSocketUrl } from "./net.js";

export type GatewayConnectionDetails = {
  url: string;
  urlSource: string;
  bindDetail?: string;
  remoteFallbackNote?: string;
  message: string;
};

type GatewayConnectionDetailResolvers = {
  loadConfig?: () => MullusiConfig;
  resolveConfigPath?: (env: NodeJS.ProcessEnv) => string;
  resolveGatewayPort?: (cfg?: MullusiConfig, env?: NodeJS.ProcessEnv) => number;
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function buildGatewayConnectionDetailsWithResolvers(
  options: {
    config?: MullusiConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
  } = {},
  resolvers: GatewayConnectionDetailResolvers = {},
): GatewayConnectionDetails {
  const config = options.config ?? resolvers.loadConfig?.() ?? {};
  const configPath =
    options.configPath ??
    resolvers.resolveConfigPath?.(process.env) ??
    resolveConfigPath(process.env);
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort =
    resolvers.resolveGatewayPort?.(config, process.env) ?? resolveGatewayPort(config);
  const bindMode = config.gateway?.bind ?? "loopback";
  const scheme = tlsEnabled ? "wss" : "ws";
  const localUrl = `${scheme}://127.0.0.1:${localPort}`;
  const cliUrlOverride =
    typeof options.url === "string" && options.url.trim().length > 0
      ? options.url.trim()
      : undefined;
  const envUrlOverride = cliUrlOverride
    ? undefined
    : trimToUndefined(process.env.MULLUSI_GATEWAY_URL);
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
  const urlSourceHint =
    options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined);
  const url = urlOverride || remoteUrl || localUrl;
  const urlSource = urlOverride
    ? urlSourceHint === "env"
      ? "env MULLUSI_GATEWAY_URL"
      : "cli --url"
    : remoteUrl
      ? "config gateway.remote.url"
      : remoteMisconfigured
        ? "missing gateway.remote.url (fallback local)"
        : "local loopback";
  const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;

  const allowPrivateWs = process.env.MULLUSI_ALLOW_INSECURE_PRIVATE_WS === "1";
  if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
    throw new Error(
      [
        `SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
        "Both credentials and chat data would be exposed to network interception.",
        `Source: ${urlSource}`,
        `Config: ${configPath}`,
        "Fix: Use wss:// for remote gateway URLs.",
        "Safe remote access defaults:",
        "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18790:127.0.0.1:18790 user@gateway-host)",
        "- or use Tailscale Serve/Funnel for HTTPS remote access",
        allowPrivateWs
          ? undefined
          : "Break-glass (trusted private networks only): set MULLUSI_ALLOW_INSECURE_PRIVATE_WS=1",
        "Doctor: mullusi doctor --fix",
        "Docs: https://docs.mullusi.com/gateway/remote",
      ].join("\n"),
    );
  }

  const message = [
    `Gateway target: ${url}`,
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
