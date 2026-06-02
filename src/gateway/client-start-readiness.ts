import type {
  GatewayClientStartable,
  GatewayClientStartReadinessOptions,
} from "../../packages/gateway-client/src/readiness.js";
import { startGatewayClientWithReadinessWait } from "../../packages/gateway-client/src/readiness.js";
import { waitForEventLoopReady, type EventLoopReadyResult } from "./event-loop-ready.js";

export type {
  GatewayClientStartable,
  GatewayClientStartReadinessOptions,
} from "../../packages/gateway-client/src/readiness.js";

/** Starts a Gateway client after the event loop proves timers and microtasks can run. */
export function startGatewayClientWhenEventLoopReady(
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  return startGatewayClientWithReadinessWait(waitForEventLoopReady, client, options);
}
