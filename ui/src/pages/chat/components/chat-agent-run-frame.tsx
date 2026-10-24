import { insert, type JSX } from "@solidjs/web";
import {
  createMemo,
  createEffect,
  createRoot,
  createSignal,
  For,
  getOwner,
  Match,
  onSettled,
  runWithOwner,
  Show,
  Switch,
  type Accessor,
} from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { extractChatSourcePreviews } from "../../../lib/chat/source-previews.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  agentRunFrameActiveStatusParts,
  chatItemGroups,
  type AgentRunFrameRenderItem,
} from "../chat-agent-run-grouping.ts";
import type { TurnRecap } from "../chat-progress.ts";
import { rawMessageTimestamp } from "../chat-thread-items.ts";
import {
  ActivityGroup,
  MessageGroup,
  MessageGroupContent,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";
import {
  StreamGroup,
  StreamPartView,
  WorkGroupSummary,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream-view.tsx";
import { resolveGroupReplyLine } from "./chat-reply-attribution.ts";
import { ChatSourcePreviews } from "./chat-source-previews.tsx";
import { BrowserTabPreviews } from "./chat-tool-cards.solid.tsx";
import { selectWorkGroupBrowserTabPreviews } from "./chat-tool-cards.ts";

type AgentRunFrameOptions = {
  basePath?: string;
  sessionPublicOrigin?: string;
  streamOptions: StreamGroupOptions;
  renderGroupOptions: (group: MessageGroupData) => NativeMessageGroupOptions;
  isWorkExpanded: (key: string) => boolean;
  onToggleWork: (key: string, expanded: boolean) => void;
  turnRecap?: TurnRecap;
};
type FrameProps = { frame: AgentRunFrameRenderItem; options: AgentRunFrameOptions };
type BodyPart =
  | Exclude<AgentRunFrameRenderItem["parts"][number], { kind: "stream-run" }>
  | StreamGroupPart;
type PartInput = { part: BodyPart; options: AgentRunFrameOptions };
type PartRange = {
  start: Comment;
  end: Comment;
  write: (input: PartInput) => void;
  dispose: () => void;
};

/** Completion can reorder the reply after a live widget has moved into it. */
function FrameBody(props: {
  parts: readonly BodyPart[];
  options: AgentRunFrameOptions;
  children: (input: Accessor<PartInput>) => JSX.Element;
}): JSX.Element {
  // Canvas widgets move between these foreign-DOM ranges without disconnecting.
  // Mount new ranges under the frame's owner, not the transient reconciliation effect.
  const owner = getOwner();
  const anchor = document.createComment("frame-body");
  const [readParent, setParent] = createSignal<HTMLElement | null>(null, { ownedWrite: true });
  const ranges = new Map<string, PartRange>();
  const retire = (range: PartRange) => {
    // Native descendants must park their widgets while the range is still connected.
    range.dispose();
    const after = range.end.nextSibling;
    for (let node: Node | null = range.start; node && node !== after;) {
      const following: Node | null = node.nextSibling;
      node.parentNode?.removeChild(node);
      node = following;
    }
  };
  onSettled(() => {
    const committedParent = anchor.parentElement;
    if (!committedParent) {
      throw new Error("Run frame body anchor was not committed");
    }
    setParent(committedParent);
    return () => {
      for (const range of ranges.values()) {
        retire(range);
      }
      ranges.clear();
    };
  });
  createEffect(
    () => ({
      parent: readParent(),
      parts: props.parts,
      options: props.options,
      render: props.children,
    }),
    ({ parent, parts, options, render }) => {
      if (!parent) {
        return;
      }
      const keys = new Set(parts.map((part) => `${part.kind}:${part.key}`));
      // Park outgoing canvas views before a new range looks them up.
      for (const [key, range] of ranges) {
        if (!keys.has(key)) {
          retire(range);
          ranges.delete(key);
        }
      }
      const ordered = parts.map((value) => {
        const key = `${value.kind}:${value.key}`;
        const existing = ranges.get(key);
        if (existing) {
          existing.write({ part: value, options });
          return existing;
        }
        const start = document.createComment("frame-part");
        const end = document.createComment("/frame-part");
        parent.insertBefore(start, anchor);
        parent.insertBefore(end, anchor);
        const range = runWithOwner(owner, () =>
          createRoot((dispose): PartRange => {
            // The headline's connection scope must change with its activity.
            const [readInput, write] = createSignal({ part: value, options }, { ownedWrite: true });
            insert(parent, render(readInput), end);
            return { start, end, write, dispose };
          }),
        );
        ranges.set(key, range);
        return range;
      });
      let reference: Node = anchor;
      for (const range of ordered.toReversed()) {
        if (range.end.nextSibling !== reference) {
          const after = range.end.nextSibling;
          for (let node: Node | null = range.start; node && node !== after;) {
            const following: Node | null = node.nextSibling;
            if (parent.isConnected && typeof parent.moveBefore === "function") {
              parent.moveBefore(node, reference);
            } else {
              parent.insertBefore(node, reference);
            }
            node = following;
          }
        }
        reference = range.start;
      }
    },
  );
  return anchor;
}

function prepareFrame(frame: AgentRunFrameRenderItem, opts: AgentRunFrameOptions) {
  const groups = chatItemGroups(frame);
  const firstAssistant = groups.find((group) => group.role === "assistant");
  const actionOwner = frame.outcome.kind === "completed" ? frame.outcome.actionOwner : null;
  const representative = firstAssistant ?? groups[0];
  const streamStarts = frame.parts.flatMap((part) =>
    part.kind === "stream-run" ? part.parts.map((streamPart) => streamPart.startedAt) : [],
  );
  const streamRun = frame.parts.find((part) => part.kind === "stream-run");
  const shell: MessageGroupData = {
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
  const frameReplyLine = resolveGroupReplyLine(
    (actionOwner && groups.find((group) => group.messages.includes(actionOwner))) || shell,
    opts.renderGroupOptions(shell).resolveReplyPreview,
    groups.flatMap((group) => group.messages),
  );
  // A preceding segment becoming history must not reparent the live answer.
  const bodyParts = frame.parts.flatMap<BodyPart>((part) =>
    part.kind === "stream-run" ? part.parts : [part],
  );
  const firstBubbleKey =
    bodyParts
      .flatMap((part) =>
        part.kind === "stream"
          ? part.text.trim()
            ? [part.key]
            : []
          : part.kind === "group" && part.role !== "tool"
            ? part.messages
                .filter((message) => message.hasVisibleContent)
                .map((message) => message.key)
            : [],
      )
      .at(0) ?? null;
  const workPreviews = selectWorkGroupBrowserTabPreviews(
    frame.parts.flatMap((part) =>
      !opts.streamOptions.bubbleMode && part.kind === "work-group" && !opts.isWorkExpanded(part.key)
        ? [part]
        : [],
    ),
    opts.renderGroupOptions(shell),
  );
  const sourcePreviews = actionOwner
    ? extractChatSourcePreviews({
        groups,
        answer: actionOwner.message,
        runId: frame.runId,
        basePath: opts.basePath,
        sessionPublicOrigin: opts.sessionPublicOrigin,
      })
    : [];
  return {
    shell,
    actionOwner,
    frameReplyLine,
    bodyParts,
    firstBubbleKey,
    workPreviews,
    sourcePreviews,
  };
}

export function AgentRunFrame(props: FrameProps) {
  const statusParts = createMemo(() => agentRunFrameActiveStatusParts(props.frame));
  return (
    <Show when={statusParts()} fallback={<RunFrame frame={props.frame} options={props.options} />}>
      {(parts) => <StreamGroup parts={parts()} options={props.options.streamOptions} />}
    </Show>
  );
}

function RunFrame(props: FrameProps) {
  const state = createMemo(() => prepareFrame(props.frame, props.options));
  const timedWork = createMemo(() => {
    const recap = props.options.turnRecap;
    const work = props.frame.parts.find(
      (part) => part.kind === "work-group" && part.replyRunId === props.frame.runId,
    );
    // The recap retains this run's terminal timing after the session moves on.
    // Handoffs have no work summary: their request-wide timing stays in the recap.
    if (!recap || work?.kind !== "work-group") {
      return undefined;
    }
    const durationMs = work.durationMs ?? recap.runtimeMs;
    return durationMs > 0 ? { ...work, durationMs } : undefined;
  });
  const frameContent = [
    <FrameBody parts={state().bodyParts} options={props.options}>
      {(input) => {
        const part = () => input().part;
        const options = () => input().options;
        const groupOptions = (group: MessageGroupData) => ({
          ...options().renderGroupOptions(group),
          firstBubbleKey: state().firstBubbleKey,
        });
        const streamPart = () => {
          const value = part();
          return value.kind === "stream" ||
            value.kind === "reading-indicator" ||
            value.kind === "question"
            ? value
            : undefined;
        };
        const workPart = () => {
          const value = part();
          return value.kind === "work-group" ? value : undefined;
        };
        const activityPart = () => {
          const value = part();
          return value.kind === "activity-run" ? value : undefined;
        };
        const messageGroup = () => {
          const value = part();
          return value.kind === "group" ? value : undefined;
        };
        return (
          <Switch>
            <Match when={streamPart()}>
              {(stream) => (
                <StreamPartView
                  part={stream()}
                  options={{
                    ...options().streamOptions,
                    firstBubbleKey: state().firstBubbleKey,
                  }}
                  presentation="standalone"
                />
              )}
            </Match>
            <Match when={workPart()}>
              {(work) => (
                <>
                  <WorkGroupSummary
                    item={timedWork()?.key === work().key ? timedWork()! : work()}
                    options={{
                      expanded: options().isWorkExpanded(work().key),
                      mediaReadAllowed: options().streamOptions.mediaReadAllowed,
                      bubbleMode: options().streamOptions.bubbleMode,
                      onToggle: () =>
                        options().onToggleWork(work().key, options().isWorkExpanded(work().key)),
                      presentation: "continuation",
                      browserTabPreviews: state().workPreviews.get(work().key),
                    }}
                  />
                  <Show when={options().isWorkExpanded(work().key)}>
                    <For each={work().groups} keyed={(group) => group.key}>
                      {(group) => (
                        <MessageGroupContent group={group()} options={groupOptions(group())} />
                      )}
                    </For>
                  </Show>
                </>
              )}
            </Match>
            <Match when={activityPart()}>
              {(activity) => {
                const groups = () => activity().groups;
                return (
                  <Show when={groups()[0]}>
                    {(first) => (
                      <ActivityGroup
                        groups={groups()}
                        options={options().renderGroupOptions(first())}
                        presentation="continuation"
                      />
                    )}
                  </Show>
                );
              }}
            </Match>
            <Match when={messageGroup()}>
              {(group) => (
                <>
                  <MessageGroupContent group={group()} options={groupOptions(group())} />
                  <BrowserTabPreviews previews={state().workPreviews.get(group().key)} />
                </>
              )}
            </Match>
          </Switch>
        );
      }}
    </FrameBody>,
    <ChatSourcePreviews
      sources={state().sourcePreviews}
      fetchFavicon={props.options.streamOptions.fetchLinkFavicon}
    />,
    <Show when={props.frame.outcome.kind === "interrupted"}>
      <div class="chat-tasks-status chat-turn-recap chat-turn-recap--continuation" role="status">
        {t("chat.composer.runInterrupted")}
      </div>
    </Show>,
  ];
  return (
    <MessageGroup
      group={state().shell}
      options={{
        ...props.options.renderGroupOptions(state().shell),
        frameContent,
        frameReplyLine: state().frameReplyLine,
        frameActionOwner: state().actionOwner,
        turnRecap: props.options.turnRecap,
        hideTurnRecapDuration: timedWork() !== undefined,
      }}
    />
  );
}
