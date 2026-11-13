import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { dynamic } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { groupToolCalls } from "../../../../../src/chat/tool-call-grouping.js";
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
  describeToolGroup,
  summarizeToolGroup,
  readPreparedActivity,
} from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { isInlineCommandCard } from "../chat-activity-segments.ts";
import {
  ownSessionLaunchCalls,
  resolveSessionLaunchPresentation,
} from "../chat-spawned-subagent.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { selectActivityHeadline } from "./chat-activity-headline-selection.ts";
import { ChatActivityHeadline } from "./chat-activity-headline.solid.tsx";
import {
  ActivityOperation,
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
  const headline = selectActivityHeadline(currentActivity, preparedByCard);
  const activityKey = source?.key ?? firstGroup.key;
  const activityDisclosureId = `activity:${activityKey}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(activityKey).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  const ownLaunches = ownSessionLaunchCalls(cards);
  const groupSummaryLabel = summarizeToolGroup(visibleActivity, {
    ownSessionLaunches: new Set(
      activity
        .filter((item) => ownLaunches.has(item.toolCallId ?? item.itemId))
        .map((item) => activityKeys.get(item)!),
    ),
    activityKeys,
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
  const visibleCalls = new Set(visibleActivity.map((item) => item.toolCallId ?? item.itemId));
  const soleStep =
    !headline &&
    !reviewOutcome &&
    approvalReviews.length === 0 &&
    cardGroups.length === 1 &&
    step !== undefined &&
    step.children.length > 0 &&
    visibleCalls.size === 1 &&
    (stepActivity?.status === "completed" || stepActivity?.status === "failed") &&
    visibleCalls.has(stepActivity.toolCallId ?? stepActivity.itemId);
  if (!source && (activityExpanded || soleStep || opts.inlineCommands)) {
    for (const card of projection!.hidden) {
      toolCardOverrides.set(card, null);
    }
    for (const group of cardGroups) {
      for (const card of descendantCards(group)) {
        toolCardOverrides.set(card, null);
      }
      if (group.children.length > 0 || group.executionCards?.length) {
        toolCardOverrides.set(group.card, { group, options: opts, contexts: toolContexts });
      }
    }
  }

  return {
    firstGroup,
    toolContexts,
    preparedByCard,
    activityKeys,
    headline,
    groupSummaryLabel,
    visibleActivity,
    reviewOutcome,
    approvalReviews,
    activityDisclosureId,
    activityBodyId,
    activityExpanded,
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
  renderEntries: ActivityEntries;
  inline?: boolean;
  liveBubble?: boolean;
}) {
  let disclosureContent: HTMLSpanElement | undefined;
  const syncOverflow = (event: Event) => syncToolDisclosureOverflow(event, disclosureContent);
  const state = () => props.state;
  const overrides = () => props.state.toolCardOverrides;
  const groups = () => props.groups;
  const soleStep = () => state().soleStep && !props.options.bubbleMode;
  const exposed = () => soleStep() || props.inline;
  const compact = () => Boolean(props.options.bubbleMode);
  const liveBubble = () =>
    compact() &&
    (props.liveBubble ??
      props.groups.some((group) => group.key === props.options.bubbleActivityGroupKey));
  return (
    <div
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
            bubbleMode={liveBubble()}
            contentRef={(element) => (disclosureContent = element)}
            activity={state().headline}
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
        <Show when={exposed() || state().activityExpanded}>
          {(_visible) => props.renderEntries(overrides, groups)}
        </Show>
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

function ActivityOperationSegments(props: ActivityGroupContentProps & { state: ActivityState }) {
  const segments = createMemo(() => {
    const result: Array<{
      key: string;
      standalone: boolean;
      inline?: boolean;
      operations: ActivityOperationGroup[];
      unmatchedActivity?: ReturnType<typeof readPreparedActivity>;
      content?: MessageGroupData;
    }> = [];
    const byMessage = new Map<string, ActivityOperationGroup[]>();
    for (const operation of props.state.cardGroups) {
      const key = props.state.toolContexts.get(operation.card)!.messageKey;
      const operations = byMessage.get(key) ?? [];
      operations.push(operation);
      byMessage.set(key, operations);
    }
    const represented = new Set(
      [...props.state.preparedByCard.values()].map((activity) =>
        props.state.activityKeys.get(activity),
      ),
    );
    const visible = new Set(props.state.visibleActivity);
    for (const group of props.groups) {
      for (const entry of group.messages) {
        for (const operation of byMessage.get(entry.key) ?? []) {
          const standalone = isStandaloneActivity(operation.card);
          const inline =
            Boolean(props.options.inlineCommands) && isInlineCommandCard(operation.card);
          const previous = result.at(-1);
          if (!standalone && previous && !previous.standalone && previous.inline === inline) {
            previous.operations.push(operation);
          } else {
            result.push({
              key: props.state.toolContexts.get(operation.card)!.disclosureId,
              standalone,
              inline,
              operations: [operation],
            });
          }
        }
        const unmatchedActivity = readPreparedActivity(entry.message).filter(
          (activity) =>
            visible.has(activity) && !represented.has(props.state.activityKeys.get(activity)),
        );
        if (unmatchedActivity.length > 0) {
          const previous = result.at(-1);
          if (previous && !previous.standalone && !previous.inline) {
            previous.unmatchedActivity = [
              ...(previous.unmatchedActivity ?? []),
              ...unmatchedActivity,
            ];
          } else {
            result.push({
              key: `${entry.key}:activity`,
              standalone: false,
              operations: [],
              unmatchedActivity,
            });
          }
        }
        if (
          resolveMessageVisibleContent(entry.message, normalizeMessage(entry.message)) ===
          "non-text"
        ) {
          result.push({
            key: `${entry.key}:output`,
            standalone: true,
            operations: [],
            content: { ...group, messages: [entry] },
          });
        }
      }
    }
    // Appending a lifecycle card must not close the activity the reader already opened.
    if (result[0] && !result[0].standalone) {
      result[0].key = props.state.firstGroup.key;
    }
    return result;
  });
  const contentOverrides = createMemo(
    () => new Map([...props.state.toolContexts.keys()].map((card) => [card, null])),
  );

  return (
    <>
      <For each={segments()} keyed={(segment) => segment.key}>
        {(segment) => {
          const prepared = createMemo(() => {
            const selected = new Set([
              ...(segment().unmatchedActivity ?? []),
              ...segment().operations.flatMap((operation) =>
                [operation.card, ...descendantCards(operation)].flatMap((card) => {
                  const activity = props.state.preparedByCard.get(card);
                  return activity ? [activity] : [];
                }),
              ),
            ]);
            return prepareActivityGroup(props.groups, props.options, {
              rootGroups: new Map(
                segment().operations.map((operation) => [operation.card, operation]),
              ),
              toolCardOverrides: props.state.toolCardOverrides,
              currentRunActivity:
                segment() === segments().at(-1) ? props.state.currentRunActivity : new Set(),
              visibleActivity: selected,
              key: segment().key,
            });
          });
          const entries = () => (
            <For
              each={segment().operations}
              keyed={(operation) => props.state.toolContexts.get(operation.card)!.disclosureId}
            >
              {(operation) => (
                <ActivityOperation
                  group={operation()}
                  options={props.options}
                  contexts={props.state.toolContexts}
                />
              )}
            </For>
          );
          return (
            <Show
              when={segment().content}
              fallback={
                <Show
                  when={segment().standalone}
                  fallback={
                    <Show when={prepared()}>
                      {(state) => (
                        <ActivityGroupBody {...props} state={state()} renderEntries={entries} />
                      )}
                    </Show>
                  }
                >
                  {entries()}
                </Show>
              }
            >
              {(content) => props.renderEntries(contentOverrides, () => [content()])}
            </Show>
          );
        }}
      </For>
    </>
  );
}

export function ActivityGroupContent(props: ActivityGroupContentProps) {
  const state = createMemo(() => prepareActivityGroup(props.groups, props.options));
  const InlineContent = dynamic(() => props.options.inlineCommands?.InlineActivityGroupContent);
  const body = () => (
    <Show
      when={state()!.cardGroups.some((group) => isStandaloneActivity(group.card))}
      fallback={
        <Show
          when={props.options.inlineCommands}
          fallback={<ActivityGroupBody {...props} state={state()!} />}
        >
          <InlineContent {...props} state={state()!} />
        </Show>
      }
    >
      <ActivityOperationSegments {...props} state={state()!} />
    </Show>
  );

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
