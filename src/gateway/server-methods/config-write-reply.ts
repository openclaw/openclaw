import { isRecord } from "../../utils.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

/**
 * Success replies carry and log the write's billing-route warnings. Error replies, including a
 * write that persisted but was not applied, moved no route and stay unchanged.
 */
export function replyWithBillingRouteWarnings(
  respond: RespondFn | undefined,
  warnings: readonly string[],
  context: GatewayRequestContext | undefined,
): RespondFn {
  return (...args) => {
    const [ok, payload] = args;
    if (ok && warnings.length > 0 && isRecord(payload)) {
      for (const warning of warnings) {
        context?.logGateway?.warn(warning);
      }
      args[1] = { ...payload, billingRouteWarnings: warnings };
    }
    // Forward the caller's exact arguments; responders and tests observe their arity.
    respond?.(...args);
  };
}
