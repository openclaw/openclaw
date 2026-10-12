import type {
  ConfiguredModelEgress,
  ConfiguredModelEgressOptions,
} from "../secrets/model-egress.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export type { ConfiguredModelEgress, ConfiguredModelEgressOptions };

const loadModelEgressRuntime = createLazyRuntimeModule(() => import("../secrets/model-egress.js"));

/** Private official-plugin runtime for a standalone job's protected model credential. */
export async function withConfiguredModelEgress<T>(
  options: ConfiguredModelEgressOptions,
  run: (egress: ConfiguredModelEgress) => Promise<T>,
): Promise<T> {
  return (await loadModelEgressRuntime()).withConfiguredModelEgress(options, run);
}
