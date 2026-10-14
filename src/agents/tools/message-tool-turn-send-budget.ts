import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { resolveEffectiveMessageAccountId } from "../../infra/outbound/message-action-routing.js";
import {
  resolveEffectiveMessageToolsConfig,
  shouldApplyCrossContextMarker,
} from "../../infra/outbound/outbound-policy.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { AgentToolResult } from "../runtime/index.js";
import { jsonResult } from "./common.js";
import { resolveOutboundActionRoute } from "./message-tool-outbound-route.js";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  formatTurnSendBlockedNotice,
  formatTurnSendNotice,
  releaseTurnSend,
  reserveTurnSend,
  type TurnSendReserveResult,
} from "./turn-send-ledger.js";

type TurnSendBudgetContext = {
  key: { sessionKey: string; runId: string; targetKey: string };
  action: ChannelMessageActionName;
  agentId: string | undefined;
  deliveryChannel: string | undefined;
};

/**
 * Ledger session key for the message tool's per-turn send budget. Folds main-session
 * aliases the way the CLI loopback grant does, so native and CLI candidates of one
 * logical turn share a ledger slot (mcp-grant-context.ts).
 */
function buildMessageToolTurnSendSessionKey(input: {
  cfg: OpenClawConfig | undefined;
  agentId: string | undefined;
  sessionKey: string | undefined;
}): string | undefined {
  return buildTurnSendLedgerSessionKey(
    input.agentId,
    input.agentId && input.sessionKey
      ? canonicalizeMainSessionAlias({
          cfg: input.cfg,
          agentId: input.agentId,
          sessionKey: input.sessionKey,
        })
      : undefined,
  );
}

/**
 * Gate for the per-turn send budget. The loop detector can't see reworded resends of
 * the same answer (it hashes full params), so the message tool counts sends handed to
 * delivery per (turn, target) and nudges from the second onward. This runs independently of
 * `loopDetection.enabled` — it is on by default. A budget applies only to a
 * cross-context write action with a single normalized target, a ledger session key, and
 * a run id; broadcast fan-out and dry-runs are excluded, leaving the budget inert.
 */
type TurnSendBudgetContextInput = {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  cfg: OpenClawConfig;
  agentId: string | undefined;
  accountId: string | undefined;
  channel: string | undefined;
  currentChannel: {
    currentChannelProvider?: string;
    currentChannelId?: string;
    currentMessagingTarget?: string;
  };
  /** Config the main-session alias folds against; the tool's construction-time config. */
  sessionConfig: OpenClawConfig | undefined;
  /** Raw agent session key; folded to the ledger key here. */
  sessionKey: string | undefined;
  runId: string | undefined;
};

function resolveTurnSendBudgetContext(
  input: TurnSendBudgetContextInput,
): TurnSendBudgetContext | undefined {
  const { runId } = input;
  const sessionKey = buildMessageToolTurnSendSessionKey({
    cfg: input.sessionConfig,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
  });
  if (
    !shouldApplyCrossContextMarker(input.action) ||
    sessionKey === undefined ||
    runId === undefined ||
    input.args.dryRun
  ) {
    return undefined;
  }
  const targetKey = resolveOutboundActionRoute({
    action: input.action,
    args: input.args,
    channel: input.channel,
    // Key the budget on the account delivery resolves, not the omitted input, so an
    // omitted-account send shares one slot with explicit and conversations_send sends.
    resolveAccountId: (route) =>
      resolveEffectiveMessageAccountId({
        cfg: input.cfg,
        channel: route.channel,
        channelPlugin: resolveOutboundChannelPlugin({
          channel: route.channel,
          cfg: input.cfg,
          agentId: input.agentId,
        }),
        accountId: input.accountId,
        agentId: input.agentId,
        target: route.target,
      }),
    currentChannelProvider: input.currentChannel.currentChannelProvider,
    currentChannelId: input.currentChannel.currentChannelId,
    currentMessagingTarget: input.currentChannel.currentMessagingTarget,
  });
  return targetKey === undefined
    ? undefined
    : {
        key: { sessionKey, runId, targetKey },
        action: input.action,
        agentId: input.agentId,
        deliveryChannel: input.channel,
      };
}

/**
 * Per-turn send-budget controller for one message-tool invocation. Captures the ledger
 * reservation and the resolved config so the caller reserves once, then settles exactly
 * once against the same reservation: `settleCompletedResult` on completion,
 * `settleQueuedDelivery` when the Gateway took queue custody, `release()` for any other
 * failure/throw. Inert (no reservation) when no budget context applies.
 */
type MessageToolTurnSendBudget = {
  /**
   * Present only when the configured cap is already reached this turn; the caller
   * suppresses the send and returns this result to the model.
   */
  readonly exhaustedResult: AgentToolResult<unknown> | undefined;
  /** Roll back the in-flight reservation when the send failed, threw, or did not land. */
  release(): void;
  /**
   * Settle a send the Gateway accepted into its durable delivery queue
   * (OUTBOUND_DELIVERY_QUEUED). Recovery still delivers it, so it keeps its charge like a
   * landed send: a distinct follow-up stays capped, while the committed operation id still
   * admits a same-key replay. The charge is not refunded if delivery later dead-letters.
   * Accepted edge case: if route detection did not mark the route as deduplicating, the
   * commit carries no operation id and a same-key replay is cap-blocked (fails closed).
   */
  settleQueuedDelivery(response: AgentToolResult<unknown>): AgentToolResult<unknown>;
  /**
   * Settle a completed action: commit when it landed, or release when it did not, then
   * append the normalization notice and, once the target has received >= 2 messages this
   * turn and the nudge is enabled, the soft-nudge notice to the response (the action's
   * tool result, or its payload as JSON when it has none).
   */
  settleCompletedResult(
    toolResult: AgentToolResult<unknown> | undefined,
    result: MessageActionResult,
  ): AgentToolResult<unknown>;
};

// Broadcast fan-out, dry-runs, and suppressed or failed sends deliver nothing to the
// budgeted target, so their reservation is released instead of committed.
function didMessageActionLand(result: MessageActionResult): boolean {
  if (result.kind === "broadcast" || result.dryRun) {
    return false;
  }
  const deliveryStatus = result.kind === "send" ? result.sendResult?.deliveryStatus : undefined;
  return deliveryStatus !== "suppressed" && deliveryStatus !== "failed";
}

function resolveNormalizationNotice(result: MessageActionResult): string | undefined {
  return result.kind === "send" && !result.dryRun ? result.normalization?.notice : undefined;
}

const INACTIVE_BUDGET: MessageToolTurnSendBudget = {
  exhaustedResult: undefined,
  release() {},
  settleQueuedDelivery: (response) => response,
  settleCompletedResult(toolResult, result) {
    return appendMessageToolNotices(
      toolResult ?? jsonResult(result.payload),
      resolveNormalizationNotice(result),
      undefined,
    );
  },
};

/**
 * Reserves one send against the per-turn ledger and returns a controller to settle it.
 * Media sends (`sendAttachment` / `upload-file`) stay visible to the soft nudge but never
 * charge the hard cap. When the delivery route dedups a completed operation through the
 * Gateway, the reservation carries the idempotency key so an idempotent replay is admitted
 * past the cap without recounting. Call it immediately before dispatch: nothing settles a
 * reservation except this controller.
 */
export function prepareMessageToolTurnSendBudget(
  input: TurnSendBudgetContextInput & {
    /** Config the per-agent message-tool budget settings are read from. */
    rawConfig: OpenClawConfig;
    gatewayPresent: boolean;
    actionIdempotencyKey: string | undefined;
  },
): MessageToolTurnSendBudget {
  const budgetContext = resolveTurnSendBudgetContext(input);
  if (!budgetContext) {
    return INACTIVE_BUDGET;
  }
  const effectiveMessageTools = resolveEffectiveMessageToolsConfig({
    cfg: input.rawConfig,
    agentId: budgetContext.agentId,
  });
  const { action } = budgetContext;
  const isMediaSendAction = action === "sendAttachment" || action === "upload-file";
  const maxPerTurn = isMediaSendAction
    ? undefined
    : effectiveMessageTools?.maxMessagesPerTurnPerTarget;
  const deliveryChannel = normalizeMessageChannel(budgetContext.deliveryChannel);
  const channelPlugin = deliveryChannel ? getChannelPlugin(deliveryChannel) : undefined;
  const routeDedupsCompletedOperation =
    input.gatewayPresent &&
    (channelPlugin?.actions?.resolveExecutionMode?.({ action }) === "gateway" ||
      channelPlugin?.outbound?.deliveryMode === "gateway");
  const reservation: TurnSendReserveResult = reserveTurnSend(budgetContext.key, {
    maxPerTurn,
    operationId: routeDedupsCompletedOperation ? input.actionIdempotencyKey : undefined,
    chargeCap: !isMediaSendAction,
  });
  // A `replay` reservation was deduped by the Gateway, so neither settlement touches it.
  const release = () => {
    if (reservation.status === "reserved") {
      releaseTurnSend(reservation.reservation);
    }
  };
  // Commits the charge and returns the soft-nudge text once the target has received >= 2
  // sends this turn.
  const commit = (): string | undefined => {
    if (reservation.status !== "reserved") {
      return undefined;
    }
    const sendCount = commitTurnSend(reservation.reservation);
    return sendCount >= 2 && effectiveMessageTools?.turnSendNudge !== false
      ? formatTurnSendNotice(sendCount, "target")
      : undefined;
  };
  return {
    exhaustedResult:
      reservation.status === "exhausted"
        ? jsonResult({
            status: "suppressed",
            reason: "turn_send_budget_exhausted",
            message: formatTurnSendBlockedNotice(maxPerTurn, "target"),
          })
        : undefined,
    release,
    settleQueuedDelivery(response) {
      return appendMessageToolNotices(response, undefined, commit());
    },
    settleCompletedResult(toolResult, result) {
      const landed = didMessageActionLand(result);
      if (!landed) {
        release();
      }
      return appendMessageToolNotices(
        toolResult ?? jsonResult(result.payload),
        resolveNormalizationNotice(result),
        landed ? commit() : undefined,
      );
    },
  };
}

/**
 * Appends the normalization and soft-nudge notices to a completed message-tool result as
 * trailing text blocks. The nudge also rides in details because a Code Mode guest program
 * only ever sees the projected details, never the text content.
 */
function appendMessageToolNotices(
  response: AgentToolResult<unknown>,
  normalizationNotice: string | undefined,
  turnSendNotice: string | undefined,
): AgentToolResult<unknown> {
  const notices = [normalizationNotice, turnSendNotice].filter((text): text is string =>
    Boolean(text),
  );
  if (notices.length === 0) {
    return response;
  }
  return {
    ...response,
    content: [...response.content, ...notices.map((text) => ({ type: "text" as const, text }))],
    ...(turnSendNotice && isRecord(response.details)
      ? { details: { ...response.details, turnSendNotice } }
      : {}),
  };
}
