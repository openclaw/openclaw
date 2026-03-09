import { requireActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginService } from "../plugins/types.js";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider.js";

const CLOUD_SANDBOX_SERVICE_PREFIX = "cloud-sandbox:";

/**
 * Extended service record that carries the CloudSandboxProvider instance.
 *
 * Plugin registers a service with:
 *   id = "cloud-sandbox:<provider-id>"
 *   provider = <CloudSandboxProvider instance>
 */
export type CloudSandboxServiceRecord = OpenClawPluginService & {
  provider: CloudSandboxProvider;
};

/**
 * Resolve a CloudSandboxProvider from the plugin service registry.
 *
 * Convention: the plugin registers a service with
 *   id = "cloud-sandbox:<provider-id>"
 * and attaches a `provider` property to the service object.
 *
 * @param providerId - Optional provider id to filter by (e.g. "ags", "e2b").
 *   When omitted, returns the first registered cloud-sandbox provider.
 * @returns The resolved provider, or null if none is registered.
 */
export function resolveCloudSandboxProvider(providerId?: string): CloudSandboxProvider | null {
  const registry = requireActivePluginRegistry();
  const prefix = providerId
    ? `${CLOUD_SANDBOX_SERVICE_PREFIX}${providerId}`
    : CLOUD_SANDBOX_SERVICE_PREFIX;

  const matches = registry.services.filter((s) =>
    providerId ? s.service.id === prefix : s.service.id.startsWith(prefix),
  );

  for (const entry of matches) {
    const record = entry.service as CloudSandboxServiceRecord;
    if (record.provider) {
      return record.provider;
    }
  }
  return null;
}
