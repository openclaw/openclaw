import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { appendCurrentInboundContext } from "../../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { captureGatewayScopeMatcher } from "../../../gateway/session-runtime-scope.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { isFollowupRunAborted, type InternalFollowupRun } from "./types.js";

function roomKey(source: InternalFollowupRun): string {
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: source.originatingChannel,
      to: source.originatingTo,
      accountId: source.originatingAccountId,
      threadId: source.originatingThreadId,
    }),
    source.originatingChatId ?? "",
    source.originatingChatType ?? "",
  ]);
}

function preview(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= limit ? cleaned : `${truncateUtf16Safe(cleaned, limit - 1)}…`;
}

/** Context belongs to an existing turn, never to a second runnable backlog. */
export function preserveAmbientOverflowContext(
  source: InternalFollowupRun,
  candidates: InternalFollowupRun[],
  cap: number,
): boolean {
  const input = source.controllerInput;
  if (!input) {
    return false;
  }
  const route = roomKey(source);
  const matchesGateway = captureGatewayScopeMatcher(getGatewayContextResolver(input));
  const recipient = candidates.find(
    (item) =>
      item !== source &&
      item.controllerInput &&
      !item.ambientOverflowContext?.attached &&
      !isFollowupRunAborted(item) &&
      matchesGateway(item.controllerInput) &&
      roomKey(item) === route,
  );
  if (!recipient) {
    return false;
  }
  const approved = source.userTurnTranscriptRecorder?.getPendingInputMessage?.();
  // Unstaged sources still owe their write hook. Never bypass it by copying raw
  // text into another turn's context, or restore text the hook already redacted.
  const text = approved
    ? (extractTextFromChatContent(approved.content, { joinWith: "\n" }) ?? "")
    : source.userTurnTranscriptRecorder
      ? "[Content omitted: input write hook has not approved this message.]"
      : source.summaryLine || source.prompt;
  const context = (recipient.ambientOverflowContext ??= { entries: [] });
  context.entries.push({
    sequence: input.sequence,
    line: JSON.stringify({
      sender: preview(source.run.senderName || source.run.senderId || "unknown", 80),
      messageId: preview(source.messageId ?? "", 80),
      text: preview(text, 160),
    }),
  });
  context.entries.sort((a, b) => a.sequence - b.sequence);
  context.entries.splice(0, Math.max(0, context.entries.length - Math.min(20, Math.floor(cap))));
  return true;
}

export function attachAmbientOverflowContext(source: InternalFollowupRun): void {
  const context = source.ambientOverflowContext;
  if (!context || context.attached) {
    return;
  }
  context.attached = true;
  source.currentInboundContext = appendCurrentInboundContext(source.currentInboundContext, [
    {
      kind: "conversation-data",
      text: `[Compacted ambient room context; oldest to newest; previews may be truncated. Background only, not requests from the current sender.]\n${context.entries.map((entry) => entry.line).join("\n")}`,
    },
  ]);
}
