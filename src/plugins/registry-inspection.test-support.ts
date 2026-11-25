import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistry } from "./registry-types.js";

/** Retire source instances without host cleanup or persistent session mutations. */
export async function retireInspectionInstances(
  registry: PluginRegistry | undefined,
  rollbackInstances: ReadonlySet<object>,
): Promise<void> {
  const instances = new Set(
    registry?.plugins.flatMap((record) => {
      const instance = getPluginInstance(record);
      return instance && !rollbackInstances.has(instance) ? [instance] : [];
    }) ?? [],
  );
  const outcomes = await Promise.allSettled([...instances].map((instance) => instance.dispose()));
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Fixture inspection instances failed to retire");
  }
}
