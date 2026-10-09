import { pluginInstanceState, type PluginInstanceHandle } from "./plugin-instance-scope.js";

const { values: valueInstances } = pluginInstanceState;

/** Associate the descriptor value graph without replacing values or invoking accessors. */
export function adoptPluginInstanceValue<T>(instance: PluginInstanceHandle, value: T): T {
  const seen = new Set<object>();
  const visit = (candidate: unknown) => {
    if (
      !candidate ||
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      seen.has(candidate)
    ) {
      return;
    }
    seen.add(candidate);
    valueInstances.set(candidate, instance);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      if ("value" in descriptor) {
        visit(descriptor.value);
      }
    }
  };
  visit(value);
  return value;
}
