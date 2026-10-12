import { createHash } from "node:crypto";
import { createPluginStateError, parseStoredJson } from "./plugin-state-error.js";
import type { PluginStateReadRow } from "./plugin-state-store.kernel.js";
import type {
  PluginStateObservation,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

const COMPARISON_PATTERN = /^1:([a-f0-9]{64}):([a-f0-9]{64}|-)$/u;

export function validatePluginStateComparison(
  value: string,
  operation: PluginStateStoreOperation,
): string {
  const match = typeof value === "string" ? COMPARISON_PATTERN.exec(value) : null;
  const scope = match?.[1];
  if (!scope) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      message: "Plugin state comparison must be an observation returned by this store.",
    });
  }
  return scope;
}

function digest(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function pluginStateComparisonScope(
  storeIdentity: string,
  key: { pluginId: string; namespace: string; key: string },
): string {
  return digest([storeIdentity, key.pluginId, key.namespace, key.key]);
}

export function createPluginStateObservation(
  databasePath: string,
  scope: string,
  row: PluginStateReadRow | undefined,
  operation: PluginStateStoreOperation,
): PluginStateObservation<unknown> {
  // Preserve the stored JSON image; caller reserialization can change legacy whitespace/key order.
  const image = row ? digest([row.value_json, row.created_at, row.expires_at]) : "-";
  return {
    value: row ? parseStoredJson(row.value_json, operation, databasePath) : undefined,
    comparison: `1:${scope}:${image}`,
  };
}
