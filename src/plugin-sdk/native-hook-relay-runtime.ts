// Private retained native-hook relay capability for bundled runtime owners.
import { registerOwnedNativeHookRelay } from "../agents/harness/native-hook-relay.js";

export {
  buildNativeHookRelayCommandPlan,
  type NativeHookRelayCommandPlan,
} from "../agents/harness/native-hook-relay-plan.js";

export type OwnedNativeHookRelayParams = Parameters<typeof registerOwnedNativeHookRelay>[0];

/** Bundled owners retain child policy and record execution custody after host admission. */
export function registerNativeHookRelayForBundledRuntime(params: OwnedNativeHookRelayParams) {
  return registerOwnedNativeHookRelay(params);
}
