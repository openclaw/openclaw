import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageGroup as MessageGroupData, ToolCard } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../../lib/chat/message-visibility.ts";
import {
  readToolApprovalReviewOutcome,
  readToolApprovalReviews,
  resolveToolApprovalReviewOutcome,
} from "../../../lib/chat/tool-approval-reviews.ts";
import {
  summarizeToolGroup,
  readPreparedActivity,
  describeToolGroup,
} from "../../../lib/chat/tool-call-grouping.ts";
import { resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import { resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ownSessionLaunchCalls, readSubagentCancellation } from "../chat-spawned-subagent.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { selectActivityHeadline } from "./chat-activity-headline-selection.ts";
import {
  ChatActivityHeadline,
  createActivityHeadlinePresentation,
} from "./chat-activity-headline.solid.tsx";
import { descendantCards, isExecutedCommandCard } from "./chat-activity-operations.ts";
import {
  segmentActivityGroup,
  collectActivityGroup,
  type ActivityGroupData,
  type ProjectedActivity,
} from "./chat-activity-projection.ts";
import { ChatCompactionActivity } from "./chat-compaction-activity.tsx";
import {
  ActivityOperation,
  PreparedActivityRow,
  LifecycleOperations,
} from "./chat-message-activity-operation.tsx";
import type {
  ActivityOperationProps,
  ActivityOperationGroup,
} from "./chat-message-bubble-options.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-options.ts";
import { syncToolDisclosureOverflow } from "./chat-tool-card-chrome.tsx";
import { ToolReviewOutcome } from "./chat-tool-outcome-summary.solid.tsx";

function prepareActivityGroup(
  opts: NativeMessageGroupOptions,
  source: {
    data: ActivityGroupData;
    cardGroups: ActivityOperationGroup[];
    currentRunActivity: ReadonlySet<ReturnType<typeof readPreparedActivity>[number]>;
    activeGroup: boolean;
    visibleActivity: ReadonlySet<ProjectedActivity>;
    key: string;
  },
) {
  const {
    data,
    cardGroups,
    currentRunActivity: activeRunActivity,
    activeGroup,
    key: activityKey,
  } = source;
  const { firstGroup, entries, toolContexts } = data;
  const selectedCards = new Set<ToolCard>();
  const pending = [...cardGroups];
  for (const group of pending) {
    selectedCards.add(group.card);
    for (const card of group.executionCards ?? []) {
      selectedCards.add(card);
    }
    pending.push(...group.children);
  }
  const cards = [...selectedCards];
  const preparedByCard = new Map(
    cards.flatMap((card) => {
      const item = data.preparedByCard.get(card);
      return item ? [[card, item] as const] : [];
    }),
  );
  const visibleActivity = [...source.visibleActivity]
    .filter((item) => !item.hideFromChannelProgress && !item.suppressChannelProgress)
    .toSorted((left, right) => data.activityOrder.get(left)! - data.activityOrder.get(right)!);
  const rawFallback = cardGroups.length > 0 && !visibleActivity.some((item) => !item.compaction);
  const activityKeys = rawFallback ? new Map(data.activityKeys) : data.activityKeys;
  const currentActivity = [
    ...new Map(
      visibleActivity
        .filter((item) => activeRunActivity.has(item))
        .map((item) => [activityKeys.get(item)!, item]),
    ).values(),
  ];
  const activityDisclosureId = `activity:${activityKey}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(activityKey).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  const ownLaunches = ownSessionLaunchCalls(cards);
  const summaryByCard = rawFallback ? new Map(preparedByCard) : preparedByCard;
  // Older/raw-only pages still have canonical call and result facts, but no prepared labels.
  const rawSummaryActivity = rawFallback
    ? cardGroups.map(({ card }) => {
        const call = unwrapToolCallForDisplay(card);
        const outcome = resolveToolCardOutcome(card, opts.runActive);
        const item: ProjectedActivity = {
          itemId: card.id,
          sourceOrder: toolContexts.get(card)!.sourceOrder,
          toolCallId: card.callId,
          name: call.name,
          title: resolveToolDisplayIdentity(call.name).label,
          kind: "tool",
          phase: card.completed ? "end" : "start",
          status:
            outcome === "succeeded"
              ? "completed"
              : outcome === "unrecorded" || outcome === "unknown"
                ? undefined
                : outcome,
        };
        activityKeys.set(
          item,
          JSON.stringify([
            toolContexts.get(card)!.runId,
            card.callId ?? toolContexts.get(card)!.disclosureId,
          ]),
        );
        summaryByCard.set(card, item);
        return item;
      })
    : [];
  const summaryActivity = [...visibleActivity, ...rawSummaryActivity];
  const rawHeadlineActivity = activeGroup ? rawSummaryActivity : [];
  const headline = selectActivityHeadline(
    rawHeadlineActivity.length
      ? [...currentActivity, ...rawHeadlineActivity].toSorted(
          (left, right) => (left.sourceOrder ?? -1) - (right.sourceOrder ?? -1),
        )
      : currentActivity,
    summaryByCard,
    opts.subagents?.subagentSessions,
    opts.subagents?.recordedStopNames,
  );
  const executedCommands = new Set<string>();
  const subagentCancellations = new Map<string, boolean>();
  const interruptedCalls = new Set<string>();
  for (const card of cards) {
    const item = summaryByCard.get(card);
    if (!item) {
      continue;
    }
    const call = unwrapToolCallForDisplay(card);
    const key = activityKeys.get(item)!;
    const runId = toolContexts.get(card)?.runId;
    if (
      runId &&
      opts.interruptedRunIds?.has(runId) &&
      resolveToolCardOutcome(card, opts.runActive) === "unrecorded"
    ) {
      interruptedCalls.add(key);
    }
    const cancellation = readSubagentCancellation(card);
    if (cancellation) {
      subagentCancellations.set(key, cancellation.stopped);
    }
    if (
      resolveToolCallInput(call.name, asNullableRecord(call.args)).kind === "command" &&
      isExecutedCommandCard(card)
    ) {
      executedCommands.add(key);
    }
  }
  const continuingExecutions = new Set<string>();
  if (activeGroup && !visibleActivity.some((item) => item.status === "running")) {
    for (const group of cardGroups) {
      if (
        !group.executionCards?.some(
          (card) => (preparedByCard.get(card) ?? card.activity)?.status === "running",
        )
      ) {
        continue;
      }
      const operations = [group.card, ...descendantCards(group)];
      // A running child owns the current activity. Only bridge the gap between
      // command children; do not revive completed reads or edits in a mixed batch.
      for (const card of operations) {
        const call = unwrapToolCallForDisplay(card);
        if (resolveToolCallInput(call.name, asNullableRecord(call.args)).kind !== "command") {
          continue;
        }
        const item = summaryByCard.get(card);
        const key = item && activityKeys.get(item);
        if (key) {
          continuingExecutions.add(key);
        }
      }
    }
  }
  const containerItems = new Set(
    cardGroups.flatMap((group) =>
      (group.executionCards ?? []).flatMap((card) => {
        const item = summaryByCard.get(card);
        return item ? [item] : [];
      }),
    ),
  );
  const groupSummaryLabel = summarizeToolGroup(
    summaryActivity.filter((item) => !containerItems.has(item)),
    {
      ownSessionLaunches: new Set(
        summaryActivity
          .filter((item) => ownLaunches.has(item.toolCallId ?? item.itemId))
          .map((item) => activityKeys.get(item)!),
      ),
      activityKeys,
      executedCommands,
      continuingExecutions,
      subagentCancellations,
      interruptedCalls,
    },
  );
  const approvalReviews = cards.flatMap((card) => readToolApprovalReviews(card.details));
  const recordedReviewOutcomes = cards.flatMap((card) => {
    const outcome = readToolApprovalReviewOutcome(card.details);
    return outcome ? [outcome] : [];
  });
  const reviewOutcome = resolveToolApprovalReviewOutcome(approvalReviews, recordedReviewOutcomes);
  // A live container can be retired before its children join this narrative segment.
  // Its producer's hidden receipt must not become an empty activity disclosure.
  if (
    cardGroups.length === 0 &&
    visibleActivity.length === 0 &&
    approvalReviews.length === 0 &&
    !reviewOutcome &&
    !hasActivityMedia(entries)
  ) {
    return undefined;
  }
  // A step whose only visible activity is its own outcome keeps its direct row.
  const [step] = cardGroups;
  const stepActivity = step ? preparedByCard.get(step.card) : undefined;
  const stepCall = step && unwrapToolCallForDisplay(step.card);
  const stepInput =
    stepCall && resolveToolCallInput(stepCall.name, asNullableRecord(stepCall.args));
  const visibleCalls = new Set(visibleActivity.map((item) => item.toolCallId ?? item.itemId));
  const soleStep =
    (visibleActivity.length === 1 && visibleActivity[0]?.compaction && entries.length === 0) ||
    (!activeGroup &&
      !headline &&
      !reviewOutcome &&
      approvalReviews.length === 0 &&
      cardGroups.length === 1 &&
      step !== undefined &&
      (visibleActivity.length === 0 ||
        ((step.children.length > 0 || stepInput?.kind !== "edit" || Boolean(stepInput.path)) &&
          visibleCalls.size === 1 &&
          (stepActivity?.status === "completed" || stepActivity?.status === "failed") &&
          visibleCalls.has(stepActivity.toolCallId ?? stepActivity.itemId))));

  return {
    firstGroup,
    activityKeys,
    headline,
    resolveHeadline: (key: string) => {
      // A displayed operation keeps its current outcome when its execution
      // container disappears from the visual group after children arrive.
      const matches = (item: ReturnType<typeof readPreparedActivity>[number]) =>
        activeRunActivity.has(item) && (item.toolCallId ?? item.itemId) === key;
      const recorded =
        visibleActivity.findLast(matches) ??
        [...preparedByCard.values()].findLast(matches) ??
        rawHeadlineActivity.findLast((item) => (item.toolCallId ?? item.itemId) === key);
      return selectActivityHeadline(
        recorded ? [recorded] : [],
        summaryByCard,
        opts.subagents?.subagentSessions,
        opts.subagents?.recordedStopNames,
      );
    },
    groupSummaryLabel,
    visibleActivity,
    reviewOutcome,
    approvalReviews,
    activityDisclosureId,
    activityBodyId,
    activityExpanded,
    activeGroup,
    soleStep,
  };
}

function hasActivityMedia(entries: ActivityGroupData["entries"]) {
  return entries.some(
    ({ message }) =>
      resolveMessageVisibleContent(message, normalizeMessage(message)) === "non-text",
  );
}

type ActivityState = NonNullable<ReturnType<typeof prepareActivityGroup>>;
type ActivityEntries = (
  overrides: () => ReadonlyMap<ToolCard, ActivityOperationProps | null>,
  groups: () => readonly MessageGroupData[],
) => JSX.Element;

function ActivityGroupBody(props: {
  state: ActivityState;
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  renderEntries: () => JSX.Element;
  inline?: boolean;
  liveBubble?: boolean;
  headlinePresentation?: ReturnType<typeof createActivityHeadlinePresentation>;
}) {
  let disclosureContent: HTMLSpanElement | undefined;
  const syncOverflow = (event: Event) => syncToolDisclosureOverflow(event, disclosureContent);
  const state = () => props.state;
  const soleStep = () => state().soleStep && !props.options.bubbleMode;
  const exposed = () => soleStep() || props.inline;
  const compact = () => Boolean(props.options.bubbleMode);
  const liveBubble = () =>
    compact() &&
    (props.liveBubble ??
      props.groups.some((group) => group.key === props.options.bubbleActivityGroupKey));
  return (
    <div
      hidden={props.headlinePresentation?.pending() ?? false}
      class={[
        "chat-activity-group",
        {
          "chat-activity-group--step": soleStep(),
          "chat-activity-group--inline": props.inline,
          "chat-activity-group--bubble": compact(),
          "chat-activity-group--working": liveBubble(),
          "is-open": !soleStep() && state().activityExpanded,
        },
      ]}
      data-explicitly-expanded={
        !exposed() &&
        state().activityExpanded &&
        props.options.isToolMessageExplicitlyExpanded?.(state().activityDisclosureId)
          ? "true"
          : undefined
      }
      data-file-session-key={state().firstGroup.senderSession?.sessionKey ?? undefined}
    >
      <Show when={!exposed()}>
        <button
          class="chat-inline-disclosure chat-activity-group__summary"
          type="button"
          aria-expanded={state().activityExpanded ? "true" : "false"}
          aria-controls={state().activityBodyId}
          aria-label={
            liveBubble() && !state().headline?.title ? t("chat.view.workingDetails") : undefined
          }
          onPointerEnter={syncOverflow}
          onFocus={syncOverflow}
          onClick={() =>
            props.options.onToggleToolMessageExpanded?.(
              state().activityDisclosureId,
              state().activityExpanded,
            )
          }
        >
          <ChatActivityHeadline
            bubbleMode={liveBubble() && !state().activityExpanded}
            contentRef={(element) => (disclosureContent = element)}
            activity={
              props.headlinePresentation ? props.headlinePresentation.selected() : state().headline
            }
            summary={state().groupSummaryLabel}
            pluginToolIcons={props.options.pluginToolIcons}
            outcomes={describeToolGroup(state().visibleActivity, {
              activityKeys: state().activityKeys,
            }).outcomes.map(({ label }) => label)}
          />{" "}
          <openclaw-chat-tool-review-outcome style={{ display: "contents" }}>
            <ToolReviewOutcome
              outcome={state().reviewOutcome}
              reviewer={state().approvalReviews[0]?.label}
            />
          </openclaw-chat-tool-review-outcome>
          <span class="chat-tool-row__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </button>
      </Show>
      <div
        class="chat-activity-group__body"
        id={exposed() ? undefined : state().activityBodyId}
        hidden={!exposed() && !state().activityExpanded}
      >
        <Show when={exposed() || state().activityExpanded}>{props.renderEntries()}</Show>
      </div>
    </div>
  );
}

export type ActivityGroupContentProps = {
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  presentation: "standalone" | "continuation";
  renderEntries: ActivityEntries;
};

function ActivityOperationSegments(props: ActivityGroupContentProps & { data: ActivityGroupData }) {
  const segments = createMemo(() => {
    const { data, groups, options } = props;
    const source = segmentActivityGroup(groups, options, data);
    // Segments have distinct disclosure keys; the original group owns run membership.
    const activeGroup = Boolean(
      options.runActive &&
      (options.activityGroupKey === undefined ||
        groups.some((group) => group.key === options.activityGroupKey)) &&
      (!options.activityRunId ||
        data.entries.some(({ message }) => transcriptRunId(message) === options.activityRunId)),
    );
    let boundary: string | undefined;
    return source.map((segment, index) => {
      if (segment.standalone) {
        boundary = segment.key;
        return { segment, boundary, prepared: undefined };
      }
      const { context, entries } = segment;
      const operations = entries.flatMap((entry) =>
        entry.operation ? [entry.operation.group] : (entry.message?.operations ?? []),
      );
      const selected = new Set([
        ...entries.flatMap((entry) => (entry.activity ? [entry.activity] : [])),
        ...operations.flatMap((operation) =>
          [operation.card, ...descendantCards(operation)].flatMap((card) => {
            const activity = context.state.preparedByCard.get(card);
            return activity ? [activity] : [];
          }),
        ),
      ]);
      const isTail = index === source.length - 1;
      const prepared = prepareActivityGroup(context.options, {
        data: context.state,
        cardGroups: operations,
        currentRunActivity: isTail ? context.state.currentRunActivity : new Set(),
        activeGroup: isTail && activeGroup,
        visibleActivity: selected,
        key: segment.key,
      });
      return { segment, boundary, prepared };
    });
  });
  const activeSegment = () => segments().at(-1);
  // Inline layout can split the same work into new DOM groups. Its active
  // headline keeps one clock; recorded standalone events establish new boundaries.
  const headlinePresentation = createActivityHeadlinePresentation({
    get scope() {
      const active = activeSegment();
      return JSON.stringify([
        props.options.sessionKey,
        props.options.connectionEpoch,
        props.options.activityRunId ?? transcriptRunId(props.data.firstGroup.messages[0]?.message),
        props.data.firstGroup.key,
        active?.boundary,
        Boolean(active?.prepared),
      ]);
    },
    get activity() {
      const state = activeSegment()?.prepared;
      return state?.activityExpanded ? undefined : state?.headline;
    },
    resolveActivity: (key) => activeSegment()?.prepared?.resolveHeadline(key),
    get active() {
      const active = activeSegment();
      const state = active?.prepared;
      return Boolean(
        state?.activeGroup &&
        !state.activityExpanded &&
        !(state.soleStep && !props.options.bubbleMode) &&
        !active?.segment.inline,
      );
    },
  });

  return (
    <>
      <For each={segments()} keyed={(item) => item.segment.key}>
        {(item) => {
          const segment = () => item().segment;
          const isTail = () => item() === activeSegment();
          const prepared = () => item().prepared;
          const entries = () => (
            <For each={segment().entries} keyed={(entry) => entry.key}>
              {(entry) => (
                <Show
                  when={entry().operation}
                  fallback={
                    <Show
                      when={entry().message}
                      fallback={
                        <Show when={entry().activity}>
                          {(activity) => (
                            <Show
                              when={activity().compaction}
                              fallback={
                                <PreparedActivityRow
                                  activity={activity()}
                                  options={props.options}
                                />
                              }
                            >
                              {(compaction) => <ChatCompactionActivity item={compaction()} />}
                            </Show>
                          )}
                        </Show>
                      }
                    >
                      {(message) =>
                        props.renderEntries(
                          () => message().overrides,
                          () => [message().group],
                        )
                      }
                    </Show>
                  }
                >
                  {(operation) => <ActivityOperation {...operation()} />}
                </Show>
              )}
            </For>
          );
          return (
            <Show
              when={segment().standalone}
              fallback={
                <Show when={prepared()}>
                  {(state) => (
                    <ActivityGroupBody
                      {...props}
                      groups={segment().context.groups}
                      options={segment().context.options}
                      state={state()}
                      renderEntries={entries}
                      headlinePresentation={isTail() ? headlinePresentation : undefined}
                      inline={segment().inline}
                      liveBubble={
                        isTail() &&
                        segment().context.groups.some(
                          (group) => group.key === segment().context.options.bubbleActivityGroupKey,
                        )
                      }
                    />
                  )}
                </Show>
              }
            >
              <Show when={segment().lifecycle} fallback={entries()}>
                <LifecycleOperations
                  kind={segment().lifecycle!}
                  operations={segment().entries.flatMap((entry) =>
                    entry.operation ? [entry.operation] : [],
                  )}
                />
              </Show>
            </Show>
          );
        }}
      </For>
    </>
  );
}

export function ActivityGroupContent(props: ActivityGroupContentProps) {
  const data = createMemo(() => {
    const group = collectActivityGroup(props.groups, props.options);
    if (
      group &&
      (group.cardGroups.length ||
        group.visibleActivity.length ||
        group.cards.some(
          ({ details }) =>
            readToolApprovalReviews(details).length || readToolApprovalReviewOutcome(details),
        ) ||
        hasActivityMedia(group.entries))
    ) {
      return group;
    }
    return undefined;
  });
  const body = () => <ActivityOperationSegments {...props} data={data()!} />;

  return (
    <Show when={data()}>
      {(activity) => (
        <Show when={props.presentation === "standalone"} fallback={body()}>
          <div
            class="chat-group tool chat-group--turn-block chat-group--activity chat-group--with-footer"
            data-chat-row-key={activity().firstGroup.key}
          >
            <div class="chat-group-messages">{body()}</div>
          </div>
        </Show>
      )}
    </Show>
  );
}
