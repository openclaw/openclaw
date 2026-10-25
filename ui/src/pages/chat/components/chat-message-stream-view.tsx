import { createMemo, For, lazy, Show } from "solid-js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { QuestionPrompt } from "../../../app/question-prompt.ts";
import type { ChatReplyTarget, ChatItem } from "../../../lib/chat/chat-types.ts";
import "../../../components/tooltip.ts";
import { ChatAvatar, type ChatAvatarProps } from "../chat-avatar-view.tsx";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { MessageRenderOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import {
  prepareChatStreamRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import { ChatTimestamp } from "./chat-message-timestamp-view.tsx";
import { resolveGroupReplyLine } from "./chat-reply-attribution.ts";
import { ReplyLineView, ReplyLineConnector } from "./chat-reply-attribution.tsx";
import type { ReplyConnectorElements } from "./chat-reply-connector.tsx";
import type { ReplyPreviewLookup } from "./chat-reply-preview.types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

const ChatQuestionSummary = lazy(() => import("./chat-question-summary.tsx"), {
  export: "ChatQuestionSummary",
});

/** A contiguous run of in-flight streaming items rendered under one assistant group. */
export type StreamGroupPart = Extract<
  ChatItem,
  { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" }
>;

export type StreamGroupOptions = MessageRenderOptions & {
  resolveReplyPreview?: ReplyPreviewLookup;
  branding?: ThemeBranding;
  bubbleMode?: boolean;
  bubbleActivityActive?: boolean;
  firstBubbleKey?: string | null;
  onReply?: (target: ChatReplyTarget) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  assistant?: ChatAvatarProps["assistant"];
  showAssistantAvatar?: boolean;
  startupLabel?: string;
  retryAt?: number;
  waitingApproval?: boolean;
  waitingSubagents?: ChatSubagentWait;
  runningSubagents?: number;
  onOpenSubagents?: () => void;
  runOutputTokens?: number | null;
  questionPrompts?: ReadonlyMap<string, QuestionPrompt>;
};

export function StreamGroupParts(props: {
  parts: StreamGroupPart[];
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const firstBubbleKey = createMemo(() =>
    props.options.firstBubbleKey !== undefined
      ? props.options.firstBubbleKey
      : (props.parts.find((candidate) => candidate.kind === "stream" && candidate.text.trim())
          ?.key ?? null),
  );
  return (
    <For each={props.parts} keyed={(part) => `${part.kind}:${part.key}`}>
      {(part) => (
        <StreamPartView
          part={part()}
          options={{ ...props.options, firstBubbleKey: firstBubbleKey() }}
          presentation={props.presentation}
        />
      )}
    </For>
  );
}

/** A streaming answer already ends its turn: reserve its footer row before the footer content exists. */
export function renderSolidEmptyGroupFooter() {
  return <div class="chat-group-footer" aria-hidden="true" />;
}

export function UnplacedSubagentWait(props: {
  sessionKey: string;
  wait: ChatSubagentWait;
  options: StreamGroupOptions;
}) {
  const parts = createMemo<StreamGroupPart[]>(() => [
    {
      kind: "reading-indicator",
      key: `waiting-subagents:${props.sessionKey}`,
      startedAt: props.wait.startedAt,
      waitingOn: "subagents",
    },
  ]);
  return <StreamGroup parts={parts()} options={props.options} />;
}

export function StreamPartView(props: {
  part: StreamGroupPart;
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const stream = () => (props.part.kind === "stream" ? props.part : undefined);
  return (
    <Show when={stream()} fallback={<NonstreamPart {...props} />}>
      <StreamingMessage part={stream} options={props.options} />
    </Show>
  );
}

function NonstreamPart(props: {
  part: StreamGroupPart;
  options: StreamGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const indicator = () => (props.part.kind === "reading-indicator" ? props.part : undefined);
  const question = () =>
    props.part.kind === "question"
      ? props.options.questionPrompts?.get(props.part.questionId)
      : undefined;
  return (
    <Show
      when={indicator()}
      fallback={
        <Show when={question()}>
          {(prompt) => (
            <ChatLazyBoundary>
              <ChatQuestionSummary prompt={prompt()} />
            </ChatLazyBoundary>
          )}
        </Show>
      }
    >
      {(part) => (
        <ChatWorkingIndicator
          part={part()}
          options={{
            bubbleMode: props.options.bubbleMode,
            bubbleActivityActive: props.options.bubbleActivityActive,
            mascot: props.options.branding?.mascot,
            workingIndicator: props.options.branding?.workingIndicator,
            workingPhrases: props.options.branding?.workingPhrases,
            waitingApproval: props.options.waitingApproval === true,
            waitingSubagents:
              part().waitingOn === "subagents" ? props.options.waitingSubagents : undefined,
            runningSubagents: props.options.runningSubagents,
            onOpenSubagents: props.options.onOpenSubagents,
            startupLabel: props.options.startupLabel,
            retryAt: props.options.retryAt,
            outputTokens: props.options.runOutputTokens,
            presentation: props.presentation,
          }}
        />
      )}
    </Show>
  );
}

function StreamingMessage(props: {
  part: () => Extract<StreamGroupPart, { kind: "stream" }> | undefined;
  options: StreamGroupOptions;
}) {
  const part = () => props.part()!;
  const prepared = createMemo(() => prepareChatStreamRender(part()));
  const actions = createMemo(() =>
    resolveMessageActionDetails(prepared(), {
      messageId: part().key,
      onReply: props.options.onReply,
      senderLabel: props.options.assistant?.name ?? "Assistant",
    }),
  );
  return (
    <GroupedMessage
      preparation={prepared()}
      messageKey={part().key}
      options={{
        ...props.options,
        isStreaming: part().isStreaming,
        showReasoning: Boolean(part().thinking),
        messageActions: actions(),
      }}
      onOpenSidebar={props.options.onOpenSidebar}
    />
  );
}

// One assistant group per contiguous run of streaming items: a reply that
// arrives as several stream segments renders under a single avatar/footer
// instead of flashing a separate avatar+bubble per segment (#63956).
export function StreamGroup(props: { parts: StreamGroupPart[]; options: StreamGroupOptions }) {
  const replyElements: ReplyConnectorElements = {};
  const starts = () =>
    props.parts.flatMap((part) => (part.kind === "stream" ? [part.startedAt] : []));
  const startedAt = () => (starts().length ? Math.min(...starts()) : null);
  const active = () =>
    props.parts.some(
      (part) => part.kind === "reading-indicator" || (part.kind === "stream" && part.isStreaming),
    );
  const source = () => props.parts.find((part) => part.kind === "stream");
  const hasAvatar = () => Boolean(source() && props.options.showAssistantAvatar !== false);
  const replyLine = () =>
    resolveGroupReplyLine(
      {
        role: "assistant",
        messages: [],
        replyToSender: source()?.replyToSender,
        replyToMessage: source()?.replyToMessage,
      },
      props.options.resolveReplyPreview,
    );
  const hasReply = () => replyLine().state !== "hidden" && hasAvatar();
  return (
    <div
      ref={(element) => (replyElements.group = element)}
      class={[
        "chat-group assistant",
        {
          "chat-group--reply": hasReply(),
          "chat-group--working": !source(),
          "chat-group--with-footer": startedAt() !== null,
        },
      ]}
      data-chat-row-key={props.parts[0]?.key}
      data-chat-streaming={active() ? "true" : undefined}
    >
      <Show when={hasAvatar()}>
        <ChatAvatar
          role="assistant"
          mediaReadAllowed={props.options.mediaReadAllowed}
          assistant={props.options.assistant}
          elementRef={(element) => (replyElements.avatar = element)}
        />
      </Show>
      <div ref={(element) => (replyElements.messages = element)} class="chat-group-messages">
        <ReplyLineView line={replyLine()} actions={props.options} elements={replyElements} />
        <StreamGroupParts parts={props.parts} options={props.options} presentation="standalone" />
      </div>
      <Show when={hasAvatar()}>
        <ReplyLineConnector line={replyLine()} avatar={true} elements={replyElements} />
      </Show>
      <Show when={startedAt() !== null}>
        <div class="chat-group-footer" aria-hidden={active() ? "true" : undefined}>
          <Show when={!active()}>
            <div class="chat-group-footer__meta">
              <span class="chat-sender-name">{props.options.assistant?.name ?? "Assistant"}</span>
              <ChatTimestamp timestamp={startedAt()!} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
