import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractChatSourcePreviews } from "../../../lib/chat/source-previews.ts";
import {
  agentRunFrameActiveStatusParts,
  agentRunFrameGroups,
  type AgentRunFrameRenderItem,
} from "../chat-agent-run-grouping.ts";
import type { TurnRecap } from "../chat-progress.ts";
import {
  renderActivityGroup,
  renderMessageGroup,
  renderMessageGroupContent,
  renderStreamGroup,
  renderStreamGroupPart,
  renderWorkGroupSummary,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message.ts";
import { renderChatSourcePreviews } from "./chat-source-previews.ts";
import { renderBrowserTabPreviews } from "./chat-tool-cards.ts";

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
  const groups = agentRunFrameGroups(frame);
  const firstAssistant = groups.find((group) => group.role === "assistant");
  const actionOwner = frame.outcome.kind === "completed" ? frame.outcome.actionOwner : null;
  const representative = firstAssistant ?? groups[0];
  const streamStarts = frame.parts.flatMap((part) =>
    part.kind === "stream-run" ? part.parts.map((streamPart) => streamPart.startedAt) : [],
  );
  const shell: MessageGroup = {
    key: frame.key,
    kind: "group",
    role: "assistant",
    senderLabel: firstAssistant?.senderLabel,
    replyToSender:
      firstAssistant?.replyToSender ??
      frame.parts.find((part) => part.kind === "stream-run")?.replyToSender,
    messages: representative?.messages ?? [],
    visibleContent: representative?.visibleContent ?? "none",
    timestamp: Math.min(...groups.map((group) => group.timestamp), ...streamStarts, Date.now()),
    isStreaming: frame.outcome.kind === "active",
    runId: frame.runId,
  };
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
  const frameContent = [
    repeat(
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
              browserTabPreviews: renderBrowserTabPreviews(
                part.groups,
                opts.renderGroupOptions(shell),
              ),
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
        return renderFrameGroup(part);
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
    frameActionOwner: actionOwner,
    turnRecap: opts.turnRecap,
  });
}
