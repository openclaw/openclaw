import type { MullusiConfig } from "../../config/config.js";
import { createPluginRegistry, type PluginRecord } from "../registry.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { MullusiPluginApi } from "../types.js";

export {
  registerProviderPlugins as registerProviders,
  requireRegisteredProvider as requireProvider,
} from "../../test-utils/plugin-registration.js";

export function uniqueSortedStrings(values: readonly string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

export function createPluginRegistryFixture(config = {} as MullusiConfig) {
  return {
    config,
    registry: createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
    }),
  };
}

export function registerTestPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: MullusiConfig;
  record: PluginRecord;
  register(api: MullusiPluginApi): void;
}) {
  params.registry.registry.plugins.push(params.record);
  params.register(
    params.registry.createApi(params.record, {
      config: params.config,
    }),
  );
}

export function registerVirtualTestPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: MullusiConfig;
  id: string;
  name: string;
  source?: string;
  kind?: PluginRecord["kind"];
  register(this: void, api: MullusiPluginApi): void;
}) {
  registerTestPlugin({
    registry: params.registry,
    config: params.config,
    record: createPluginRecord({
      id: params.id,
      name: params.name,
      source: params.source ?? `/virtual/${params.id}/index.ts`,
      ...(params.kind ? { kind: params.kind } : {}),
    }),
    register: params.register,
  });
}
