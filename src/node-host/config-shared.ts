import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeNodeHostCloudflareAccessConfig,
  type NodeHostCloudflareAccessConfig,
} from "./gateway-cloudflare-access.js";

/** Gateway endpoint metadata persisted with node-host config. */
export type NodeHostGatewayConfig = {
  host?: string;
  port?: number;
  tls?: boolean;
  tlsFingerprint?: string;
  /** Gateway WebSocket context path (e.g. "/openclaw-gw"). */
  contextPath?: string;
  /** Cloudflare Access service-token inputs bound to this exact Gateway origin. */
  cloudflareAccess?: NodeHostCloudflareAccessConfig;
};

export type NodeHostConfig = {
  version: 1;
  nodeId: string;
  displayName?: string;
  gateway?: NodeHostGatewayConfig;
  /** Share installed macOS applications through device.apps (default: false). */
  installedAppsSharing?: boolean;
  /** Restrict this host to these exact command ids; omission keeps the full surface. */
  commands?: string[];
};

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid node-host SQLite row: ${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`invalid node-host SQLite row: ${label} must not be empty`);
  }
  return normalized;
}

function validatePort(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`invalid node-host ${label}: expected an integer between 1 and 65535`);
  }
  return value;
}

export function normalizeStoredNodeHostConfig(value: unknown): NodeHostConfig {
  if (!isRecord(value)) {
    throw new Error("invalid node-host SQLite row: expected a configuration object");
  }
  if (value.version !== 1) {
    throw new Error(`invalid node-host SQLite row: unsupported version ${String(value.version)}`);
  }
  const nodeId = typeof value.nodeId === "string" ? value.nodeId.trim() : "";
  if (!nodeId) {
    throw new Error("invalid node-host SQLite row: node_id must not be empty");
  }
  const storedGateway = value.gateway;
  if (storedGateway !== undefined && !isRecord(storedGateway)) {
    throw new Error("invalid node-host SQLite row: gateway must be an object");
  }
  const gatewayTls = storedGateway?.tls;
  if (gatewayTls !== undefined && typeof gatewayTls !== "boolean") {
    throw new Error("invalid node-host SQLite row: gateway_tls must be a boolean");
  }
  if (value.installedAppsSharing !== undefined && typeof value.installedAppsSharing !== "boolean") {
    throw new Error("invalid node-host SQLite row: installed_apps_sharing must be a boolean");
  }
  const gateway = storedGateway
    ? normalizeGatewayConfig({
        host: optionalNonEmptyString(storedGateway.host, "gateway_host"),
        port: validatePort(storedGateway.port, "SQLite gateway_port"),
        tls: typeof gatewayTls === "boolean" ? gatewayTls : undefined,
        tlsFingerprint: optionalNonEmptyString(
          storedGateway.tlsFingerprint,
          "gateway_tls_fingerprint",
        ),
        contextPath: optionalNonEmptyString(storedGateway.contextPath, "gateway_context_path"),
        ...cloudflareAccessEntry(
          normalizeNodeHostCloudflareAccessConfig(storedGateway.cloudflareAccess),
        ),
      })
    : undefined;
  return {
    version: 1,
    nodeId,
    displayName: optionalNonEmptyString(value.displayName, "display_name"),
    gateway,
    installedAppsSharing: value.installedAppsSharing === true,
    ...(value.commands !== undefined
      ? { commands: normalizeNodeHostCommands(value.commands) }
      : {}),
  };
}

export function normalizeNodeHostCommands(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("invalid node-host commands: expected an array of non-empty command ids");
  }
  return [...new Set(value.map((id: string) => id.trim()))].toSorted();
}

// Own-property parity with the retired column reader: an absent Cloudflare
// Access config omits the key entirely so toStrictEqual consumers match.
function cloudflareAccessEntry(cloudflareAccess: NodeHostCloudflareAccessConfig | undefined): {
  cloudflareAccess?: NodeHostCloudflareAccessConfig;
} {
  return cloudflareAccess ? { cloudflareAccess } : {};
}

export function normalizeGatewayConfig(
  gateway: NodeHostGatewayConfig,
): NodeHostGatewayConfig | undefined {
  const normalized: NodeHostGatewayConfig = {
    host: normalizeOptionalString(gateway.host),
    port: validatePort(gateway.port, "gateway port"),
    tls: gateway.tls,
    tlsFingerprint: normalizeOptionalString(gateway.tlsFingerprint),
    contextPath: normalizeOptionalString(gateway.contextPath),
    ...cloudflareAccessEntry(normalizeNodeHostCloudflareAccessConfig(gateway.cloudflareAccess)),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

export type PreparedNodeHostConfig = {
  explicitNodeId?: string;
  explicitDisplayName?: string;
  fallbackDisplayName?: string;
  candidateNodeId: string;
  gateway?: NodeHostGatewayConfig;
  installedAppsSharing?: boolean;
  commands?: string[];
  allCommands?: boolean;
  updatedAtMs: number;
};
