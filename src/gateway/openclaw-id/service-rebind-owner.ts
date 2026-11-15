import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type {
  createServiceRebind,
  RebindAction,
  RebindInput,
  ServiceRebind,
} from "./service-rebind.js";

/** Owns lazy re-bind loading and its Labs lifetime, independent of remote-runtime restarts. */
export function createServiceRebindOwner(
  deps: Parameters<typeof createServiceRebind>[0] & { enabled: () => boolean },
) {
  let lifetime = new AbortController();
  let steps: ServiceRebind | undefined;
  return {
    stop() {
      lifetime.abort();
    },
    run: async (action: RebindAction, channel?: Channel, input: RebindInput = {}) => {
      if (lifetime.signal.aborted && deps.enabled()) {
        lifetime = new AbortController();
      }
      const signal = lifetime.signal;
      const isCurrent = () => !signal.aborted && deps.enabled();
      const { createServiceRebind } = await import("./service-rebind.js");
      steps ??= createServiceRebind(deps);
      return await steps.run(action, channel, input, isCurrent);
    },
  };
}
