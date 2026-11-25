import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends ReadonlyArray<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

export type PluginRuntimeMockOverrides = DeepPartial<PluginRuntime>;

function mergeDeep<T>(base: T, overrides: DeepPartial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, overrideValue] of Object.entries(overrides as Record<string, unknown>)) {
    if (overrideValue === undefined) {
      continue;
    }
    const baseValue = result[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = mergeDeep(baseValue, overrideValue);
      continue;
    }
    result[key] = overrideValue;
  }
  return result as T;
}

export function mergePluginRuntimeMockOverrides(
  base: PluginRuntime,
  overrides: PluginRuntimeMockOverrides,
): PluginRuntime {
  const channel = overrides.channel;
  const runtime = mergeDeep(base, {
    ...overrides,
    channel: {
      ...channel,
      // Canonical defined overrides win; undefined keeps the legacy override.
      inbound: mergeDeep(channel?.turn ?? {}, channel?.inbound ?? {}),
    },
  });
  // Deep merging makes new objects, so rebind the alias to the final target.
  runtime.channel.turn = runtime.channel.inbound;
  return runtime;
}
