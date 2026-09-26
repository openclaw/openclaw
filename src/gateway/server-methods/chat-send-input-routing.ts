import { isDecisionAssistanceEligible } from "../../agents/decision-assistance.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { resolveQueueSettingsCore } from "../../auto-reply/reply/queue/settings.js";
import type { ReplyOperation } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import {
  AUTO_STEER_MAX_INPUT_CHARS,
  isHumanControlUiInput,
  isOrdinaryControlUiInput,
} from "./chat-send-auto-steer.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayClient } from "./shared-types.js";

/** Source Stop owns pending routing only until delivery takes custody of this input. */
export function bindChatSendInputRoutingCancellation(
  routing: ReturnType<ReplyOperation["reserveInputRouting"]>,
  source: AbortSignal,
  runAbort: {
    controller: AbortController;
    entry?: Pick<ChatAbortControllerEntry, "abortStopReason">;
  },
): ReturnType<ReplyOperation["reserveInputRouting"]> {
  const abort = () => {
    if (runAbort.controller.signal.aborted) {
      return;
    }
    if (runAbort.entry) {
      runAbort.entry.abortStopReason = isAgentRunRestartAbortReason(source.reason)
        ? "restart"
        : "rpc";
    }
    runAbort.controller.abort(source.reason);
  };
  let released = false;
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) {
    abort();
  }
  return {
    ready: routing.ready,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      source.removeEventListener("abort", abort);
      routing.release();
    },
  };
}

/** Called only from the committed writer-barrier frame, never speculative admission. */
export function reserveChatSendInputRouting(params: {
  request: NormalizedChatSendRequest;
  session: Pick<PreparedChatSendSession, "agentId" | "activeRunScopeKey">;
  client: GatewayClient | null;
  cfg: OpenClawConfig;
  entry: SessionEntry | undefined;
  operation: ReplyOperation | undefined;
  inputRouting?: ReturnType<ReplyOperation["reserveInputRouting"]>;
}) {
  const { request, session, client, cfg, entry, operation } = params;
  const ordinary = isOrdinaryControlUiInput(request, client);
  const baselineMode = resolveQueueSettingsCore({
    cfg,
    channel: INTERNAL_MESSAGE_CHANNEL,
    sessionEntry: entry,
    inlineMode: request.p.queueMode,
  }).mode;
  // Auto-off, attachment, reply, and work-context sends must not overtake an earlier hold.
  // Interrupt and commands retain their native cancellation/bypass behavior.
  const ordered = isHumanControlUiInput(request, client) && baselineMode !== "interrupt";
  const auto =
    request.p.deliveryPolicy === "auto" &&
    baselineMode !== "interrupt" &&
    request.rawMessage.length <= AUTO_STEER_MAX_INPUT_CHARS &&
    (request.p.queueMode === undefined ||
      request.p.queueMode === "steer" ||
      request.p.queueMode === "followup") &&
    isDecisionAssistanceEligible(cfg, session.agentId) &&
    cfg.plugins?.enabled !== false &&
    entry?.incognito !== true &&
    ordinary;
  const target =
    request.p.queueMode === "steer" || auto
      ? replyRunRegistry.resolveCurrentMessageInjectionTarget(session.activeRunScopeKey)
      : undefined;
  return {
    messageInjectionTarget: request.p.queueMode === "steer" ? target : undefined,
    autoSteerTarget: auto ? target : undefined,
    inputRouting:
      params.inputRouting ??
      (ordered && operation?.turnKind === "visible" ? operation.reserveInputRouting() : undefined),
  };
}
