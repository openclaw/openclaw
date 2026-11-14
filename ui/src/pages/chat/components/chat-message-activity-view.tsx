import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { groupToolCalls } from "../../../../../src/chat/tool-call-grouping.js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageGroup as MessageGroupData, ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
} from "../../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../../lib/chat/message-visibility.ts";
import {
  readToolApprovalReviewOutcome,
  readToolApprovalReviews,
  resolveToolApprovalReviewOutcome,
} from "../../../lib/chat/tool-approval-reviews.ts";
import {
  describeToolGroup,
  summarizeToolGroup,
  readPreparedActivity,
} from "../../../lib/chat/tool-call-grouping.ts";
import { resolveToolCallInput } from "../../../lib/chat/tool-call-input.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { activityEntryGroupKey, isInlineCommandCard } from "../chat-activity-segments.ts";
import {
  ownSessionLaunchCalls,
  resolveSessionLaunchPresentation,
} from "../chat-spawned-subagent.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { selectActivityHeadline } from "./chat-activity-headline-selection.ts";
import {
  ChatActivityHeadline,
  createActivityHeadlinePresentation,
} from "./chat-activity-headline.solid.tsx";
import {
  ActivityOperation,
  PreparedActivityRow,
  descendantCards,
  projectActivityOperations,
} from "./chat-message-activity-operation.tsx";
import type {
  ActivityOperationGroup,
  ActivityOperationProps,
} from "./chat-message-bubble-options.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import { syncToolDisclosureOverflow } from "./chat-tool-card-chrome.tsx";
import { ToolReviewOutcome } from "./chat-tool-outcome-summary.solid.tsx";

function isStandaloneActivity(card: ToolCard): boolean {
  return (
    resolveSessionLaunchPresentation(card) !== null ||
    Boolean(readNodePermissionRequest(asNullableRecord(card.details)?.permissionMissing))
  );
}

export function prepareActivityGroup(
  groups: readonly MessageGroupData[],
  opts: NativeMessageGroupOptions,
  source?: {
    rootGroups: ReadonlyMap<ToolCard, ActivityOperationGroup>;
    toolCardOverrides: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
    currentRunActivity: ReadonlySet<ReturnType<typeof readPreparedActivity>[number]>;
    activeGroup: boolean;
    visibleActivity?: ReadonlySet<ReturnType<typeof readPreparedActivity>[number]>;
    key?: string;
  },
) {
  const firstGroup = groups[0];
  if (!firstGroup || opts.showToolCalls === false) {
    return undefined;
  }
  const entries = groups.flatMap((group) => group.messages);
  const cards: ToolCard[] = [];
  const toolContexts = new Map<ToolCard, { messageKey: string; disclosureId: string }>();
  const preparedByCard = new Map<ToolCard, ReturnType<typeof readPreparedActivity>[number]>();
  const currentRunActivity = new Set<ReturnType<typeof readPreparedActivity>[number]>();
  const preparedByCall = new Map<string, ReturnType<typeof readPreparedActivity>[number]>();
  const cardRuns = new Map<ToolCard, string | undefined>();
  const suppressedCards = new Set<ToolCard>();
  const activityKeys = new Map<ReturnType<typeof readPreparedActivity>[number], string>();
  const activity = entries.flatMap((entry) => {
    const prepared = readPreparedActivity(entry.message);
    if (
      !source &&
      opts.runActive &&
      opts.activityRunId &&
      (opts.activityGroupKey === undefined ||
        groups.some((group) => group.key === opts.activityGroupKey)) &&
      transcriptRunId(entry.message) === opts.activityRunId
    ) {
      prepared.forEach((item) => currentRunActivity.add(item));
    }
    const runId = transcriptRunId(entry.message);
    const localPrepared = new Map(prepared.map((item) => [item.toolCallId, item]));
    for (const item of prepared) {
      activityKeys.set(item, JSON.stringify([runId ?? entry.key, item.toolCallId ?? item.itemId]));
      if (item.toolCallId) {
        preparedByCall.set(JSON.stringify([runId, item.toolCallId]), item);
      }
    }
    for (const [index, card] of extractToolCardsCached(entry.message).entries()) {
      cards.push(card);
      toolContexts.set(card, {
        messageKey: entry.key,
        disclosureId: `${entry.key}:toolcard:${index}`,
      });
      cardRuns.set(card, card.runId ?? runId);
      const local = card.callId ? localPrepared.get(card.callId) : undefined;
      if (local) {
        preparedByCard.set(card, local);
      } else if (Array.isArray(asNullableRecord(entry.message)?.activity)) {
        suppressedCards.add(card);
      }
    }
    return prepared;
  });
  for (const card of cards) {
    const item = card.callId
      ? preparedByCall.get(JSON.stringify([cardRuns.get(card), card.callId]))
      : undefined;
    if (item) {
      preparedByCard.set(card, item);
    }
  }
  const projection = source
    ? undefined
    : projectActivityOperations(groupToolCalls(cards), preparedByCard, suppressedCards);
  const hiddenActivity = new Set(
    [...(projection?.hidden ?? [])].flatMap((card) => {
      const item = preparedByCard.get(card);
      return item && item.status !== "failed" && item.status !== "blocked" ? [item] : [];
    }),
  );
  const visibleActivity = activity.filter(
    (item) =>
      (!source?.visibleActivity || source.visibleActivity.has(item)) &&
      !hiddenActivity.has(item) &&
      !item.hideFromChannelProgress &&
      !item.suppressChannelProgress,
  );
  // Segments have unique disclosure keys; the original group owns run membership.
  const activeRunActivity = source?.currentRunActivity ?? currentRunActivity;
  const currentActivity = [
    ...new Map(
      visibleActivity
        .filter((item) => activeRunActivity.has(item))
        .map((item) => [activityKeys.get(item)!, item]),
    ).values(),
  ];
  const cardGroups = source
    ? cards.flatMap((card) => {
        const root = source.rootGroups.get(card);
        return root ? [root] : [];
      })
    : projection!.groups;
  const order = new Map(cards.map((card, index) => [card, index]));
  cardGroups.sort((left, right) => order.get(left.card)! - order.get(right.card)!);
  const headline = selectActivityHeadline(
    currentActivity,
    preparedByCard,
    opts.subagents?.subagentSessions,
  );
  const activityKey = source?.key ?? firstGroup.key;
  const activityDisclosureId = `activity:${activityKey}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(activityKey).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  const ownLaunches = ownSessionLaunchCalls(cards);
  const summaryByCard = new Map(preparedByCard);
  // Older/raw-only pages still have canonical call and result facts, but no prepared labels.
  const summaryActivity = visibleActivity.length
    ? visibleActivity
    : cardGroups.map(({ card }) => {
        const call = unwrapToolCallForDisplay(card);
        const outcome = resolveToolCardOutcome(card, opts.runActive);
        const item: ReturnType<typeof readPreparedActivity>[number] = {
          itemId: card.id,
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
          JSON.stringify([cardRuns.get(card), card.callId ?? toolContexts.get(card)!.disclosureId]),
        );
        summaryByCard.set(card, item);
        return item;
      });
  const activeGroup = source
    ? source.activeGroup
    : Boolean(
        opts.runActive &&
        (opts.activityGroupKey === undefined ||
          groups.some((group) => group.key === opts.activityGroupKey)) &&
        (!opts.activityRunId ||
          entries.some(({ message }) => transcriptRunId(message) === opts.activityRunId)),
      );
  const codeExecutions = new Set<string>();
  const executedCommands = new Set<string>();
  for (const card of cards) {
    const item = summaryByCard.get(card);
    const call = unwrapToolCallForDisplay(card);
    const args = asNullableRecord(call.args);
    if (!item || resolveToolCallInput(call.name, args).kind !== "command") {
      continue;
    }
    const key = activityKeys.get(item)!;
    if (
      call.name.trim().toLowerCase() === "exec" &&
      !(typeof args?.command === "string" && args.command.trim()) &&
      [args?.code, args?.input].some((code) => typeof code === "string" && code.trim())
    ) {
      codeExecutions.add(key);
    }
    if (card.exitCode !== undefined) {
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
  const groupSummaryLabel = summarizeToolGroup(summaryActivity, {
    ownSessionLaunches: new Set(
      summaryActivity
        .filter((item) => ownLaunches.has(item.toolCallId ?? item.itemId))
        .map((item) => activityKeys.get(item)!),
    ),
    activityKeys,
    executedCommands,
    codeExecutions,
    continuingExecutions,
  });
  const toolCardOverrides = new Map<ToolCard, ActivityOperationProps | null>();
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
    !entries.some(
      ({ message }) =>
        resolveMessageVisibleContent(message, normalizeMessage(message)) === "non-text",
    )
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
    !activeGroup &&
    !headline &&
    !reviewOutcome &&
    approvalReviews.length === 0 &&
    cardGroups.length === 1 &&
    step !== undefined &&
    (visibleActivity.length === 0 ||
      ((step.children.length > 0 || stepInput?.kind !== "edit" || Boolean(stepInput.path)) &&
        visibleCalls.size === 1 &&
        (stepActivity?.status === "completed" || stepActivity?.status === "failed") &&
        visibleCalls.has(stepActivity.toolCallId ?? stepActivity.itemId)));
  for (const card of projection?.hidden ?? []) {
    toolCardOverrides.set(card, null);
  }
  if (!source) {
    for (const group of cardGroups) {
      for (const card of descendantCards(group)) {
        toolCardOverrides.set(card, null);
      }
      if (group.children.length > 0 || group.executionCards?.length) {
        toolCardOverrides.set(group.card, { group, options: opts, contexts: toolContexts });
      }
    }
  }

  const representedActivity = new Set(
    [...preparedByCard.values()].map((item) => activityKeys.get(item)),
  );
  return {
    firstGroup,
    toolContexts,
    preparedByCard,
    activityKeys,
    headline,
    resolveHeadline: (key: string) => {
      // A displayed operation keeps its current outcome when its execution
      // container disappears from the visual group after children arrive.
      const recorded = activity.findLast(
        (item) => activeRunActivity.has(item) && (item.toolCallId ?? item.itemId) === key,
      );
      return selectActivityHeadline(
        recorded ? [recorded] : [],
        preparedByCard,
        opts.subagents?.subagentSessions,
      );
    },
    groupSummaryLabel,
    visibleActivity,
    unmatchedActivity: [
      ...new Map(
        visibleActivity
          .filter((item) => !representedActivity.has(activityKeys.get(item)))
          .map((item) => [activityKeys.get(item), item]),
      ).values(),
    ],
    reviewOutcome,
    approvalReviews,
    activityDisclosureId,
    activityBodyId,
    activityExpanded,
    activeGroup,
    soleStep,
    toolCardOverrides: source?.toolCardOverrides ?? toolCardOverrides,
    cardGroups,
    currentRunActivity: activeRunActivity,
  };
}

export type ActivityState = NonNullable<ReturnType<typeof prepareActivityGroup>>;
type ActivityEntries = (
  overrides: () => ReadonlyMap<ToolCard, ActivityOperationProps | null>,
  groups: () => readonly MessageGroupData[],
) => JSX.Element;

export function ActivityGroupBody(props: {
  state: ActivityState;
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  renderEntries: () => JSX.Element;
  inline?: boolean;
  liveBubble?: boolean;
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
  const presentation = createActivityHeadlinePresentation({
    get scope() {
      return JSON.stringify([
        props.options.sessionKey,
        props.options.connectionEpoch,
        props.options.activityRunId,
        state().activityDisclosureId,
      ]);
    },
    get activity() {
      return state().activityExpanded ? undefined : state().headline;
    },
    get resolveActivity() {
      return state().resolveHeadline;
    },
    get active() {
      return state().activeGroup && !state().activityExpanded && !exposed();
    },
  });
  return (
    <div
      hidden={presentation.pending()}
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
            activity={presentation.selected()}
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

type ActivityEntry = { key: string } & (
  | { operation: ActivityOperationProps; activity?: never; message?: never }
  | {
      activity: ReturnType<typeof readPreparedActivity>[number];
      operation?: never;
      message?: never;
    }
  | {
      message: {
        group: MessageGroupData;
        overrides: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
        operations: ActivityOperationGroup[];
      };
      operation?: never;
      activity?: never;
    }
);

function ActivityOperationSegments(props: ActivityGroupContentProps & { state: ActivityState }) {
  const segments = createMemo(() => {
    // Keyed entries can still render the previous snapshot while their parent updates.
    // Operations and their object-keyed maps belong to the same projection.
    const context = { state: props.state, groups: props.groups, options: props.options };
    const result: Array<{
      key: string;
      standalone: boolean;
      inline?: boolean;
      entries: ActivityEntry[];
      context: typeof context;
    }> = [];
    const append = (item: ActivityEntry, standalone: boolean, inline: boolean, key: string) => {
      const previous = result.at(-1);
      if (!standalone && previous && !previous.standalone && previous.inline === inline) {
        previous.entries.push(item);
      } else {
        result.push({ key, context, standalone, inline, entries: [item] });
      }
    };
    const byMessage = new Map<string, ActivityOperationGroup[]>();
    for (const operation of context.state.cardGroups) {
      const key = context.state.toolContexts.get(operation.card)!.messageKey;
      const operations = byMessage.get(key) ?? [];
      operations.push(operation);
      byMessage.set(key, operations);
    }
    const unmatched = new Set(context.state.unmatchedActivity);
    for (const group of context.groups) {
      for (const entry of group.messages) {
        const operations = byMessage.get(entry.key) ?? [];
        // A mixed command/edit envelope keeps its native inline presentation.
        const inline =
          Boolean(context.options.inlineCommands) &&
          operations.some((operation) => isInlineCommandCard(operation.card));
        const nativeMessage =
          operations.length > 0 && isStandaloneToolMessageForDisplay(entry.message);
        if (nativeMessage) {
          const standalone = operations.some((operation) => isStandaloneActivity(operation.card));
          append(
            {
              key: entry.key,
              message: {
                group: { ...group, messages: [entry] },
                overrides: context.state.toolCardOverrides,
                operations,
              },
            },
            standalone,
            inline,
            standalone ? entry.key : activityEntryGroupKey(group, entry),
          );
        } else {
          for (const [index, operation] of operations.entries()) {
            const standalone = isStandaloneActivity(operation.card);
            const key = context.state.toolContexts.get(operation.card)!.disclosureId;
            append(
              {
                key,
                operation: {
                  group: operation,
                  options: context.options,
                  contexts: context.state.toolContexts,
                },
              },
              standalone,
              inline,
              standalone || index > 0 ? key : activityEntryGroupKey(group, entry),
            );
          }
        }
        for (const activity of readPreparedActivity(entry.message).filter((item) =>
          unmatched.has(item),
        )) {
          append(
            { key: context.state.activityKeys.get(activity)!, activity },
            false,
            false,
            `${entry.key}:activity`,
          );
        }
        if (
          !nativeMessage &&
          resolveMessageVisibleContent(entry.message, normalizeMessage(entry.message)) ===
            "non-text"
        ) {
          result.push({
            key: `${entry.key}:output`,
            context,
            standalone: true,
            entries: [
              {
                key: `${entry.key}:output`,
                message: {
                  group: { ...group, messages: [entry] },
                  overrides: new Map(
                    [...context.state.toolContexts.keys()].map((card) => [card, null]),
                  ),
                  operations: [],
                },
              },
            ],
          });
        }
      }
    }
    // Appending a lifecycle card must not close the activity the reader already opened.
    if (result[0] && !result[0].standalone) {
      result[0].key = context.state.firstGroup.key;
    }
    return result;
  });

  return (
    <>
      <For each={segments()} keyed={(segment) => segment.key}>
        {(segment) => {
          const isTail = () => segment().key === segments().at(-1)?.key;
          const prepared = createMemo(() => {
            const { context, entries: segmentEntries } = segment();
            const operations = segmentEntries.flatMap((entry) =>
              entry.operation ? [entry.operation.group] : (entry.message?.operations ?? []),
            );
            const selected = new Set([
              ...segmentEntries.flatMap((entry) => (entry.activity ? [entry.activity] : [])),
              ...operations.flatMap((operation) =>
                [operation.card, ...descendantCards(operation)].flatMap((card) => {
                  const activity = context.state.preparedByCard.get(card);
                  return activity ? [activity] : [];
                }),
              ),
            ]);
            return prepareActivityGroup(context.groups, context.options, {
              rootGroups: new Map(operations.map((operation) => [operation.card, operation])),
              toolCardOverrides: context.state.toolCardOverrides,
              currentRunActivity: isTail() ? context.state.currentRunActivity : new Set(),
              activeGroup: isTail() && context.state.activeGroup,
              visibleActivity: selected,
              key: segment().key,
            });
          });
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
                            <PreparedActivityRow activity={activity()} options={props.options} />
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
              {entries()}
            </Show>
          );
        }}
      </For>
    </>
  );
}

export function ActivityGroupContent(props: ActivityGroupContentProps) {
  const state = createMemo(() => prepareActivityGroup(props.groups, props.options));
  const body = () => <ActivityOperationSegments {...props} state={state()!} />;

  return (
    <Show when={state()}>
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
