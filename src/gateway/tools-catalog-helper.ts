import { callGatewayScoped } from "./call.js";
import { READ_SCOPE } from "./method-scopes.js";
import {
  PROTOCOL_VERSION,
  type ToolsCatalogResult,
} from "./protocol/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";

export type FetchToolsCatalogOptions = {
  agentId?: string;
  includePlugins?: boolean;
  url?: string;
  timeoutMs?: number;
  token?: string;
  password?: string;
  configPath?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function resolveGatewayTarget(url: string | undefined) {
  const config = loadConfig();
  const normalizedUrl = trimToUndefined(url);

  if (!normalizedUrl) {
    return {
      config,
      url: undefined,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return {
      config,
      url: normalizedUrl,
    };
  }

  if (
    (parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:") &&
    isLoopbackHostname(parsedUrl.hostname)
  ) {
    const resolvedPort = Number.parseInt(parsedUrl.port, 10);
    const port = Number.isFinite(resolvedPort)
      ? resolvedPort
      : parsedUrl.protocol === "wss:"
        ? 443
        : 80;

    const localConfig: OpenClawConfig = {
        ...config,
        gateway: {
          ...config.gateway,
          mode: "local",
          port,
          tls: {
            ...config.gateway?.tls,
            enabled: parsedUrl.protocol === "wss:",
          },
        },
      };

    return {
      config: localConfig,
      url: undefined,
    };
  }

  return {
    config,
    url: normalizedUrl,
  };
}

export async function fetchToolsCatalog(
  options: FetchToolsCatalogOptions = {},
): Promise<ToolsCatalogResult> {
  const params: Record<string, unknown> = {};
  const agentId = trimToUndefined(options.agentId);
  const gatewayTarget = resolveGatewayTarget(options.url);

  if (agentId) {
    params.agentId = agentId;
  }

  if (typeof options.includePlugins === "boolean") {
    params.includePlugins = options.includePlugins;
  }

  return await callGatewayScoped<ToolsCatalogResult>({
    method: "tools.catalog",
    params: Object.keys(params).length > 0 ? params : undefined,
    scopes: [READ_SCOPE],
    config: gatewayTarget.config,
    url: gatewayTarget.url,
    timeoutMs: options.timeoutMs,
    token: trimToUndefined(options.token),
    password: trimToUndefined(options.password),
    configPath: trimToUndefined(options.configPath),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "Jarvis Desktop",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
  });
}
