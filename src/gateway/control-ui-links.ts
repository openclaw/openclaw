import {
  inspectBestEffortPrimaryTailnetIPv4,
  pickBestEffortPrimaryLanIPv4,
} from "../infra/network-discovery-display.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { isValidIPv4 } from "./net.js";

/** Resolves user-facing Control UI HTTP and WebSocket URLs for the configured bind mode. */
export function resolveControlUiLinks(params: {
  /** Gateway listener port. */
  port: number;
  /** Bind mode used to choose the displayed host. */
  bind?: "auto" | "lan" | "loopback" | "custom" | "tailnet";
  /** IPv4 host used only when bind is custom. */
  customBindHost?: string;
  /** Optional Control UI mount path. */
  basePath?: string;
  /** Whether to emit https/wss links instead of http/ws links. */
  tlsEnabled?: boolean;
}): { httpUrl: string; wsUrl: string } {
  // Current BYOH truth: lan, tailnet, and custom bind resolve through IPv4-only helpers.
  // IPv6-only hosts need an IPv4 sidecar or proxy in front of the Gateway.
  const port = params.port;
  const bind = params.bind ?? "loopback";
  const customBindHost = params.customBindHost?.trim();
  const { tailnetIPv4 } = inspectBestEffortPrimaryTailnetIPv4();
  const host = (() => {
    if (bind === "custom" && customBindHost && isValidIPv4(customBindHost)) {
      return customBindHost;
    }
    if (bind === "tailnet" && tailnetIPv4) {
      return tailnetIPv4 ?? "127.0.0.1";
    }
    if (bind === "lan") {
      return pickBestEffortPrimaryLanIPv4() ?? "127.0.0.1";
    }
    return "127.0.0.1";
  })();
  const basePath = normalizeControlUiBasePath(params.basePath);
  // HTTP links point at the UI root while WebSocket links point at the Gateway
  // origin/base path; callers append protocol-specific paths themselves.
  const uiPath = basePath ? `${basePath}/` : "/";
  const wsPath = basePath ? basePath : "";
  const httpScheme = params.tlsEnabled === true ? "https" : "http";
  const wsScheme = params.tlsEnabled === true ? "wss" : "ws";
  return {
    httpUrl: `${httpScheme}://${host}:${port}${uiPath}`,
    wsUrl: `${wsScheme}://${host}:${port}${wsPath}`,
  };
}
