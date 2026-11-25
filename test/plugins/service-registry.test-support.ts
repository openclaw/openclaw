import {
  createTestPluginApi,
  type TestPluginApiInput,
} from "../../src/plugin-sdk/plugin-test-api.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";

export function createServiceRegistry(id: string, options: TestPluginApiInput = {}) {
  const registry = createEmptyPluginRegistry();
  const api = createTestPluginApi({
    id,
    ...options,
    registerService(service) {
      registry.services.push({
        pluginId: id,
        id: service.id.trim(),
        service,
        source: options.source ?? `${id}/index.ts`,
        origin: "bundled",
      });
    },
  });
  return { registry, api };
}
