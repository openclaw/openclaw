import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readClawHubStringArrayField, readClawHubStringField } from "./clawhub-client.js";

export type ClawHubPluginCapabilities = {
  contracts?: Record<string, string[]>;
  providers?: string[];
  channels?: string[];
};

export function parseClawHubPluginCapabilities(
  summary: Record<string, unknown>,
): ClawHubPluginCapabilities {
  const result: ClawHubPluginCapabilities = {};
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

export type ClawHubPluginCompatibility = {
  pluginApiRange?: string;
  builtWithOpenClawVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};

export function parseClawHubPluginCompatibility(
  value: Record<string, unknown> | undefined,
  context: string,
): ClawHubPluginCompatibility | undefined {
  if (!value) {
    return undefined;
  }
  const compatibility = {
    pluginApiRange: readClawHubStringField(value, "pluginApiRange", context),
    builtWithOpenClawVersion: readClawHubStringField(value, "builtWithOpenClawVersion", context),
    pluginSdkVersion: readClawHubStringField(value, "pluginSdkVersion", context),
    minGatewayVersion: readClawHubStringField(value, "minGatewayVersion", context),
  };
  const entries = Object.entries(compatibility).filter((entry): entry is [string, string] =>
    Boolean(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
