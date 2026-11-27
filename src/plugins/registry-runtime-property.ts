import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

export function readPluginRuntimeProperty(
  runtime: PluginRuntime,
  record: PluginRecord,
  prop: PropertyKey,
  receiver: unknown,
) {
  try {
    return Reflect.get(runtime, prop, receiver);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve plugin runtime module") &&
      !error.message.includes("pluginRuntimeContext=")
    ) {
      const propName =
        typeof prop === "symbol" ? (prop.description ?? prop.toString()) : String(prop);
      error.message = [
        error.message,
        `pluginRuntimeContext=pluginId:${record.id}`,
        `property:${propName}`,
        ...(record.source ? [`source:${record.source}`] : []),
      ].join("; ");
    }
    throw error;
  }
}
