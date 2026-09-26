import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneHookIsolationValue, deepFreezeHookValue } from "./hook-isolation.js";
import type {
  PluginHookInputRouteEvent,
  PluginHookInputRouteContext,
  PluginHookInputRouteResult,
  PluginHookRegistration,
} from "./hook-types.js";

/** One adviser is captured before evidence preparation, with no fallback chain. */
export function prepareInputRoute(
  getHooks: () => PluginHookRegistration<"input_route">[],
  isEligible: (pluginId: string) => boolean,
) {
  const hook = getHooks().find((entry) => isEligible(entry.pluginId));
  if (!hook) {
    return undefined;
  }
  const isCurrent = () => isEligible(hook.pluginId) && getHooks().includes(hook);
  return {
    isCurrent,
    async evaluate(
      event: PluginHookInputRouteEvent,
      ctx: PluginHookInputRouteContext,
    ): Promise<PluginHookInputRouteResult> {
      const { assertCurrent, signal } = ctx;
      assertCurrent();
      signal.throwIfAborted();
      if (!isCurrent()) {
        return { status: "unavailable" };
      }
      const result = await hook.handler(
        deepFreezeHookValue(cloneHookIsolationValue("input_route", event)),
        Object.freeze({ ...ctx }),
      );
      // Read plugin-owned accessors once, then return only host-owned primitive facts.
      const record = asOptionalRecord(result);
      const status = record?.status;
      const choice = record?.choice;
      const reason = record?.reason;
      assertCurrent();
      signal.throwIfAborted();
      if (!isCurrent()) {
        return { status: "unavailable" };
      }
      if (result === undefined || status === "abstained") {
        return { status: "abstained" };
      }
      if (status === "choice" && (choice === "steer" || choice === "followup")) {
        return { status: "choice", choice };
      }
      if (status === "unavailable" && (reason === undefined || reason === "deadline")) {
        return { status: "unavailable", ...(reason ? { reason } : {}) };
      }
      throw new Error("Invalid input_route advice.");
    },
  };
}
