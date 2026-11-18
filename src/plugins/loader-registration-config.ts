import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NormalizedPluginsConfig } from "./config-state.js";

/** Captured JSON inputs ignore object key order, but preserve array order and values. */
export function samePluginLoadInput(left: string | undefined, right: string | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      isDeepStrictEqual(JSON.parse(left), JSON.parse(right)))
  );
}

/** Configuration consumed during registration, independent of activation and load scope. */
export function resolvePluginRegistrationConfigKey(params: {
  runtimeEntries: NormalizedPluginsConfig["entries"];
  sourceEntries: NormalizedPluginsConfig["entries"];
}): string {
  const { runtimeEntries, sourceEntries } = params;
  const pluginIds = new Set([...Object.keys(runtimeEntries), ...Object.keys(sourceEntries)]);
  const inputs = [...pluginIds].toSorted().flatMap((pluginId) => {
    const { enabled: _enabled, ...runtime } = runtimeEntries[pluginId] ?? {};
    const sourceConfig = sourceEntries[pluginId]?.config;
    const registration = { ...runtime, sourceConfig };
    // Auto-enable may add an otherwise empty entry; it does not change callback inputs.
    return Object.values(registration).some((value) => value !== undefined)
      ? [[pluginId, registration]]
      : [];
  });
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}
