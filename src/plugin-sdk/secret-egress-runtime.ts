import type {
  ConfiguredModelEgress,
  ConfiguredModelEgressOptions,
} from "../secrets/model-egress.js";

export type { ConfiguredModelEgress, ConfiguredModelEgressOptions };

/** Private official-plugin runtime for a standalone job's protected model credential. */
export async function withConfiguredModelEgress<T>(
  options: ConfiguredModelEgressOptions,
  run: (egress: ConfiguredModelEgress) => Promise<T>,
): Promise<T> {
  const runtime = await import("../secrets/model-egress.js");
  options.signal?.throwIfAborted();
  return runtime.withConfiguredModelEgress(options, run);
}
