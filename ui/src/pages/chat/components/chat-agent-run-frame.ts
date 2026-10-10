import { html, nothing } from "lit";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractChatSourcePreviews } from "../../../lib/chat/source-previews.ts";
import {
  agentRunFrameActiveStatusParts,
  chatItemGroups,
  type AgentRunFrameRenderItem,
} from "../chat-agent-run-grouping.ts";
import type { TurnRecap } from "../chat-progress.ts";
import { rawMessageTimestamp } from "../chat-thread-items.ts";
import { atomicKeyedRepeat } from "./atomic-keyed-repeat.ts";
import {
  renderActivityGroup,
  renderMessageGroup,
  renderMessageGroupContent,
} from "./chat-message-group.ts";
import {
  renderStreamGroup,
  renderStreamGroupPart,
  renderWorkGroupSummary,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream.ts";
import { resolveGroupReplyLine } from "./chat-reply-attribution.ts";
import { renderChatSourcePreviews } from "./chat-source-previews.ts";
import { renderWorkGroupBrowserTabPreviews } from "./chat-tool-cards.ts";

type MessageGroupRenderOptions = Parameters<typeof renderMessageGroup>[1];

type AgentRunFrameOptions = {
  basePath?: string;
  sessionPublicOrigin?: string;
  streamOptions: StreamGroupOptions;
  renderGroupOptions: (group: MessageGroup) => MessageGroupRenderOptions;
  isWorkExpanded: (key: string) => boolean;
  onToggleWork: (key: string, expanded: boolean) => void;
  turnRecap?: TurnRecap;
};

export function renderAgentRunFrame(frame: AgentRunFrameRenderItem, opts: AgentRunFrameOptions) {
  const statusParts = agentRunFrameActiveStatusParts(frame);
  if (statusParts) {
    return renderStreamGroup(statusParts, opts.streamOptions);
  }
  const groups = chatItemGroups(frame);
  const firstAssistant = groups.find((group) => group.role === "assistant");
  const actionOwner = frame.outcome.kind === "completed" ? frame.outcome.actionOwner : null;
  const representative = firstAssistant ?? groups[0];
  const streamStarts = frame.parts.flatMap((part) =>
    part.kind === "stream-run" ? part.parts.map((streamPart) => streamPart.startedAt) : [],
  );
  const streamRun = frame.parts.find((part) => part.kind === "stream-run");
  const shell: MessageGroup = {
    key: frame.key,
    kind: "group",
    role: "assistant",
    senderLabel: firstAssistant?.senderLabel,
    replyToSender: firstAssistant?.replyToSender ?? streamRun?.replyToSender,
    replyToMessage: firstAssistant?.replyToMessage ?? streamRun?.replyToMessage,
    replyShared: firstAssistant?.replyShared,
    replyTurnSource: firstAssistant?.replyTurnSource,
    replyCurrentSource: firstAssistant?.replyCurrentSource,
    messages: representative?.messages ?? [],
    visibleContent: representative?.visibleContent ?? "none",
    timestamp:
      (actionOwner ? rawMessageTimestamp(actionOwner.message) : null) ??
      Math.min(...groups.map((group) => group.timestamp), ...streamStarts, Date.now()),
    isStreaming: frame.outcome.kind === "active",
    runId: frame.runId,
  };
  // The frame's one line follows its final answer's target.
  const frameReplyLine = resolveGroupReplyLine(
    (actionOwner && groups.find((group) => group.messages.includes(actionOwner))) || shell,
    opts.renderGroupOptions(shell).resolveReplyPreview,
    groups.flatMap((group) => group.messages),
  );
  const renderFrameGroup = (group: MessageGroup) =>
    renderMessageGroupContent(group, opts.renderGroupOptions(group));
  type BodyPart =
    | Exclude<AgentRunFrameRenderItem["parts"][number], { kind: "stream-run" }>
    | StreamGroupPart;
  // Grouping does not own body lifetime. A preceding segment becoming history
  // must not reparent the later live answer or reset its reader controls.
  const bodyParts = frame.parts.flatMap<BodyPart>((part) =>
    part.kind === "stream-run" ? part.parts : [part],
  );
  const workPreviews = renderWorkGroupBrowserTabPreviews(
    frame.parts.flatMap((part) =>
      part.kind === "work-group" && !opts.isWorkExpanded(part.key) ? [part] : [],
    ),
    opts.renderGroupOptions(shell),
  );
  const frameContent = [
    atomicKeyedRepeat(
      bodyParts,
      (part) => part.kind + ":" + part.key,
      (part) => {
        if (
          part.kind === "stream" ||
          part.kind === "reading-indicator" ||
          part.kind === "question"
        ) {
          return renderStreamGroupPart(part, opts.streamOptions, "standalone");
        }
        if (part.kind === "work-group") {
          const expanded = opts.isWorkExpanded(part.key);
          return html`
            ${renderWorkGroupSummary(part, {
              expanded,
              onToggle: () => opts.onToggleWork(part.key, expanded),
              presentation: "continuation",
              browserTabPreviews: workPreviews.get(part.key),
            })}
            ${expanded ? part.groups.map(renderFrameGroup) : nothing}
          `;
        }
        if (part.kind === "activity-run") {
          const firstGroup = part.groups[0];
          return firstGroup
            ? renderActivityGroup(part.groups, opts.renderGroupOptions(firstGroup), "continuation")
            : nothing;
        }
        return html`${renderFrameGroup(part)}${workPreviews.get(part.key) ?? nothing}`;
      },
    ),
    actionOwner
      ? renderChatSourcePreviews(
          extractChatSourcePreviews({
            groups,
            answer: actionOwner.message,
            runId: frame.runId,
            basePath: opts.basePath,
            sessionPublicOrigin: opts.sessionPublicOrigin,
          }),
          opts.streamOptions.fetchLinkFavicon,
        )
      : nothing,
  ];
  return renderMessageGroup(shell, {
    ...opts.renderGroupOptions(shell),
    frameContent,
    frameReplyLine,
    frameActionOwner: actionOwner,
    turnRecap: opts.turnRecap,
  });
}
