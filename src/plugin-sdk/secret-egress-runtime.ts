import type { JobSecretEgress, SetupSecretEgressOptions } from "../secrets/job-egress.js";
import type {
  ConfiguredModelEgress,
  ConfiguredModelEgressOptions,
} from "../secrets/model-egress.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export type { ConfiguredModelEgress, ConfiguredModelEgressOptions };
export type { JobSecretEgress, SetupSecretEgressOptions };

const loadModelEgressRuntime = createLazyRuntimeModule(() => import("../secrets/model-egress.js"));
const loadJobEgressRuntime = createLazyRuntimeModule(() => import("../secrets/job-egress.js"));

/** Private official-plugin runtime for selected setup secrets and host-only egress. */
export async function withSetupSecretEgress<T>(
  options: SetupSecretEgressOptions,
  run: (egress: JobSecretEgress) => Promise<T>,
): Promise<T> {
  return (await loadJobEgressRuntime()).withSetupSecretEgress(options, run);
}

/** Private official-plugin runtime for a standalone job's protected model credential. */
export async function withConfiguredModelEgress<T>(
  options: ConfiguredModelEgressOptions,
  run: (egress: ConfiguredModelEgress) => Promise<T>,
): Promise<T> {
  return (await loadModelEgressRuntime()).withConfiguredModelEgress(options, run);
}
