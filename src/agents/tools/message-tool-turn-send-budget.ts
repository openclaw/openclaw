import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveEffectiveMessageToolsConfig,
  shouldApplyCrossContextMarker,
} from "../../infra/outbound/outbound-policy.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  commitTurnSend,
  releaseTurnSend,
  reserveTurnSend,
  type TurnSendReserveResult,
} from "./turn-send-ledger.js";

type TurnSendBudgetContext = { sessionKey: string; runId: string; targetKey: string };

/**
 * Gate for the per-turn send budget. The loop detector can't see reworded resends of
 * the same answer (it hashes full params), so the message tool counts successful sends
 * per (turn, target) and nudges from the second onward. This runs independently of
 * `loopDetection.enabled` — it is on by default. A budget applies only to a
 * cross-context write action with a single normalized target, a ledger session key, and
 * a run id; broadcast fan-out and dry-runs are excluded, leaving the budget inert.
 */
export function resolveTurnSendBudgetContext(input: {
  action: ChannelMessageActionName;
  outboundActionRoute: string | undefined;
  sessionKey: string | undefined;
  runId: string | undefined;
  isDryRun: boolean;
}): TurnSendBudgetContext | undefined {
  if (
    shouldApplyCrossContextMarker(input.action) &&
    input.outboundActionRoute !== undefined &&
    input.sessionKey !== undefined &&
    input.runId !== undefined &&
    !input.isDryRun
  ) {
    return {
      sessionKey: input.sessionKey,
      runId: input.runId,
      targetKey: input.outboundActionRoute,
    };
  }
  return undefined;
}

/**
 * Per-turn send-budget controller for one message-tool invocation. Captures the ledger
 * reservation and the resolved config so the caller reserves once, then settles exactly
 * once against the same reservation: `release()` on failure/throw, `commitAndResolveNotice`
 * on completion. Inert (no reservation) when `budgetContext` is undefined.
 */
export type MessageToolTurnSendBudget = {
  /**
   * Present only when the configured cap is already reached this turn; the caller
   * suppresses the send and returns this text to the model.
   */
  readonly exhaustedMessage: string | undefined;
  /** Roll back the in-flight reservation when the send failed, threw, or did not land. */
  release(): void;
  /**
   * Settle a completed send: commit when it landed (returning the soft-nudge text once
   * the target has received >= 2 messages this turn and the nudge is enabled), or release
   * when it did not. Returns undefined when there is nothing to nudge about.
   */
  commitAndResolveNotice(landed: boolean): string | undefined;
};

const INACTIVE_BUDGET: MessageToolTurnSendBudget = {
  exhaustedMessage: undefined,
  release() {},
  commitAndResolveNotice() {
    return undefined;
  },
};

/**
 * Reserves one send against the per-turn ledger and returns a controller to settle it.
 * Media sends (`sendAttachment` / `upload-file`) stay visible to the soft nudge but never
 * charge the hard cap. When the delivery route dedups a completed operation through the
 * Gateway, the reservation carries the idempotency key so an idempotent replay is admitted
 * past the cap without recounting.
 */
export function prepareMessageToolTurnSendBudget(input: {
  budgetContext: TurnSendBudgetContext | undefined;
  action: ChannelMessageActionName;
  cfg: OpenClawConfig;
  agentId: string | undefined;
  gatewayPresent: boolean;
  deliveryChannel: string | undefined;
  actionIdempotencyKey: string | undefined;
}): MessageToolTurnSendBudget {
  const { budgetContext } = input;
  if (!budgetContext) {
    return INACTIVE_BUDGET;
  }
  const effectiveMessageTools = resolveEffectiveMessageToolsConfig({
    cfg: input.cfg,
    agentId: input.agentId,
  });
  const isMediaSendAction = input.action === "sendAttachment" || input.action === "upload-file";
  const maxPerTurn = isMediaSendAction
    ? undefined
    : effectiveMessageTools?.maxMessagesPerTurnPerTarget;
  const deliveryChannel = normalizeMessageChannel(input.deliveryChannel);
  const channelPlugin = deliveryChannel ? getChannelPlugin(deliveryChannel) : undefined;
  const routeDedupsCompletedOperation =
    input.gatewayPresent &&
    (channelPlugin?.actions?.resolveExecutionMode?.({ action: input.action }) === "gateway" ||
      channelPlugin?.outbound?.deliveryMode === "gateway");
  const reservation: TurnSendReserveResult = reserveTurnSend(budgetContext, {
    maxPerTurn,
    operationId: routeDedupsCompletedOperation ? input.actionIdempotencyKey : undefined,
    chargeCap: !isMediaSendAction,
  });
  return {
    exhaustedMessage:
      reservation.status === "exhausted"
        ? `Blocked: reached this turn's configured limit of ${maxPerTurn} message(s) to this target (maxMessagesPerTurnPerTarget). Finalize your reply instead of sending another message.`
        : undefined,
    release() {
      if (reservation.status === "reserved") {
        releaseTurnSend(reservation.reservation);
      }
    },
    commitAndResolveNotice(landed) {
      if (reservation.status !== "reserved") {
        return undefined;
      }
      if (!landed) {
        releaseTurnSend(reservation.reservation);
        return undefined;
      }
      const sendCount = commitTurnSend(reservation.reservation);
      if (sendCount >= 2 && effectiveMessageTools?.turnSendNudge !== false) {
        return `You have already sent ${sendCount} messages to this target this turn; if this is a rewrite of the same reply, finalize now instead of sending another variant.`;
      }
      return undefined;
    },
  };
}
