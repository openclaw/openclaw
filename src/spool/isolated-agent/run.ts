/**
 * Spool isolated agent turn wrapper.
 *
 * This is a thin wrapper that converts SpoolEvent parameters to the generic
 * IsolatedAgentTurnParams and delegates to runIsolatedAgentTurn().
 */

import type { CliDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SpoolEvent } from "../types.js";
import {
  runIsolatedAgentTurn,
  type IsolatedAgentTurnParams,
  type IsolatedAgentTurnResult,
} from "../../agents/isolated-turn/index.js";

export type RunSpoolAgentTurnResult = IsolatedAgentTurnResult;

export type RunSpoolIsolatedAgentTurnParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  event: SpoolEvent;
  lane?: string;
};

/**
 * Run an isolated agent turn for a spool event.
 *
 * This wrapper extracts the relevant parameters from the SpoolEvent and
 * calls the shared runIsolatedAgentTurn() function.
 */
export async function runSpoolIsolatedAgentTurn(
  params: RunSpoolIsolatedAgentTurnParams,
): Promise<RunSpoolAgentTurnResult> {
  const { cfg, deps, event, lane } = params;
  const payload = event.payload;

  // Build IsolatedAgentTurnParams from SpoolEvent
  const isolatedParams: IsolatedAgentTurnParams = {
    cfg,
    deps,
    message: payload.message,
    sessionKey: payload.sessionKey ?? `spool:${event.id}`,
    agentId: payload.agentId,
    lane: lane ?? "spool",

    // Agent options from payload
    model: payload.model,
    thinking: payload.thinking,
    // Note: SpoolEvent doesn't have timeoutSeconds currently

    // Delivery options from payload
    // Note: channel is cast to the expected type. ChannelId is defined as
    // `ChatChannelId | (string & {})` which accepts any string at runtime.
    // Invalid channel IDs will be handled gracefully by the delivery resolver
    // (falling back to last-used channel or failing with a clear error).
    deliver: payload.delivery?.enabled,
    channel: payload.delivery?.channel as IsolatedAgentTurnParams["channel"],
    to: payload.delivery?.to,
    // Note: SpoolEvent doesn't have bestEffortDeliver currently

    // Source information for message formatting
    source: {
      type: "spool",
      id: event.id,
      name: `spool-event-${event.id.slice(0, 8)}`,
    },
  };

  return runIsolatedAgentTurn(isolatedParams);
}
