import { redactSensitiveUrl } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  validatePluginUiCapabilities,
  type PluginUiCapability,
} from "../../packages/gateway-protocol/src/plugin-ui-capabilities.js";
import type { PluginDiscoveryDetail } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { ExternalPluginCompatibility } from "../../packages/plugin-package-contract/src/index.js";
import {
  readClawHubNonEmptyStringFields,
  readClawHubStringArrayField,
  readClawHubStringField,
  readRequiredClawHubStringField,
} from "./clawhub-client.js";

export type ClawHubPluginCapabilities = {
  contracts?: Record<string, string[]>;
  providers?: string[];
  channels?: string[];
  uiCapabilities?: PluginUiCapability[];
};

export function parseClawHubPluginCapabilities(
  summary: Record<string, unknown>,
): ClawHubPluginCapabilities {
  const result: ClawHubPluginCapabilities = {};
  const ui = validatePluginUiCapabilities(summary.uiCapabilities);
  // Older readers ignored this advisory field; invalid UI metadata must not hide the package.
  if (ui.ok && ui.capabilities !== undefined) {
    result.uiCapabilities = ui.capabilities;
  }
  for (const field of ["providers", "channels"] as const) {
    const names = readClawHubStringArrayField(summary, field, "plugin manifest summary");
    if (names) {
      result[field] = names;
    }
  }
  if (summary.contracts != null) {
    if (!isRecord(summary.contracts)) {
      throw new Error(
        "Malformed ClawHub plugin manifest summary: expected contracts to be an object.",
      );
    }
    const contracts = summary.contracts;
    result.contracts = Object.fromEntries(
      Object.keys(contracts)
        .toSorted()
        .map((family) => {
          const names = readClawHubStringArrayField(contracts, family, "plugin contracts");
          if (!names) {
            throw new Error(
              `Malformed ClawHub plugin contracts: expected ${family} to be a string array.`,
            );
          }
          return [family, names];
        }),
    );
  }
  return result;
}

export type ClawHubPluginCompatibility = ExternalPluginCompatibility;

export function parseClawHubPluginCompatibility(
  value: Record<string, unknown> | undefined,
  context: string,
): ClawHubPluginCompatibility | undefined {
  if (!value) {
    return undefined;
  }
  const compatibility = readClawHubNonEmptyStringFields(
    value,
    ["pluginApiRange", "builtWithOpenClawVersion", "pluginSdkVersion", "minGatewayVersion"],
    context,
  );
  return Object.keys(compatibility).length > 0 ? compatibility : undefined;
}

export function parseClawHubPluginMcpServer(
  entry: unknown,
  index: number,
): NonNullable<PluginDiscoveryDetail["mcpServerDetails"]>[number] {
  const context = `plugin MCP server ${index}`;
  if (!isRecord(entry)) {
    throw new Error(`Malformed ClawHub ${context}: expected an object.`);
  }
  const name = readRequiredClawHubStringField(entry, "name", context);
  const rawUrl = readClawHubStringField(entry, "url", context);
  const scope = readClawHubStringField(entry, "scope", context)?.slice(0, 1000);
  const setup = readClawHubStringField(entry, "setup", context)?.slice(0, 2000);
  let url: string | undefined;
  let endpointRedacted = entry.endpointRedacted === true;
  if (rawUrl && !endpointRedacted) {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.replace(/\.$/u, "");
      // Public manifest metadata never exposes private endpoints or credential URLs.
      // The URL is display-only; any future network use still needs its own SSRF checks.
      if (
        rawUrl.length <= 2048 &&
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        !parsed.port &&
        host.includes(".") &&
        !/^[\d.]+$/u.test(host) &&
        !host.includes(":") &&
        !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/u.test(host) &&
        redactSensitiveUrl(rawUrl) === rawUrl
      ) {
        url = rawUrl;
      }
    } catch {
      // Malformed external endpoints are withheld without hiding the server's other metadata.
    }
    endpointRedacted = !url;
  }
  return {
    name,
    ...(url ? { url } : {}),
    ...(entry.transport === "streamable-http" ||
    entry.transport === "sse" ||
    entry.transport === "stdio"
      ? { transport: entry.transport }
      : {}),
    ...(entry.auth === "oauth" || entry.auth === "api-key" || entry.auth === "none"
      ? { auth: entry.auth }
      : {}),
    ...(scope ? { scope } : {}),
    ...(setup ? { setup } : {}),
    ...(endpointRedacted ? { endpointRedacted } : {}),
  };
}
