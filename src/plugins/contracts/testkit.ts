import type { OpenClawConfig } from "../../config/config.js";
import { createPluginRegistry, type PluginRecord } from "../registry.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

export {
  registerProviderPlugins as registerProviders,
  requireRegisteredProvider as requireProvider,
} from "../../test-utils/plugin-registration.js";

export function uniqueSortedStrings(values: readonly string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function formatImportSideEffectCall(args: readonly unknown[]): string {
  if (args.length === 0) {
    return "(no args)";
  }
  return args
    .map((arg) => {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(", ");
}

export function assertNoImportTimeSideEffects(params: {
  moduleId: string;
  forbiddenSeam: string;
  calls: readonly (readonly unknown[])[];
  why: string;
  fixHint: string;
}) {
  if (params.calls.length === 0) {
    return;
  }
  const observedCalls = params.calls
    .slice(0, 3)
    .map((call, index) => `  ${index + 1}. ${formatImportSideEffectCall(call)}`)
    .join("\n");
  throw new Error(
    [
      `[runtime contract] ${params.moduleId} touched ${params.forbiddenSeam} during module import.`,
      `why this is banned: ${params.why}`,
      `expected fix: ${params.fixHint}`,
      `observed calls (${params.calls.length}):`,
      observedCalls,
    ].join("\n"),
  );
}

export function createPluginRegistryFixture(config = {} as OpenClawConfig) {
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
  config: OpenClawConfig;
  record: PluginRecord;
  register(api: OpenClawPluginApi): void;
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
  config: OpenClawConfig;
  id: string;
  name: string;
  source?: string;
  kind?: PluginRecord["kind"];
  register(this: void, api: OpenClawPluginApi): void;
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
