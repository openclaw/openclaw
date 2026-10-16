import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { groupToolCalls } from "../../../../../src/chat/tool-call-grouping.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageGroup as MessageGroupData, ToolCard } from "../../../lib/chat/chat-types.ts";
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
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { ownSessionLaunchCalls } from "../chat-spawned-subagent.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { selectActivityHeadline } from "./chat-activity-headline-selection.ts";
import { ChatActivityHeadline } from "./chat-activity-headline.solid.tsx";
import { descendantCards } from "./chat-message-activity-operation.tsx";
import type { ActivityOperationProps } from "./chat-message-bubble-options.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import { BrowserTabPreviews, syncToolDisclosureOverflow } from "./chat-tool-cards.solid.tsx";
import { selectBrowserTabPreviews } from "./chat-tool-cards.ts";
import {
  ChatToolOutcomeSummary,
  ChatToolReviewOutcome,
} from "./chat-tool-outcome-summary.solid.tsx";

function prepareActivityGroup(
  groups: readonly MessageGroupData[],
  opts: NativeMessageGroupOptions,
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
  const activity = entries.flatMap((entry) => {
    const prepared = readPreparedActivity(entry.message);
    if (
      opts.runActive &&
      opts.activityRunId &&
      (!opts.activityGroupKey || groups.some((group) => group.key === opts.activityGroupKey)) &&
      transcriptRunId(entry.message) === opts.activityRunId
    ) {
      prepared.forEach((item) => currentRunActivity.add(item));
    }
    const byCallId = new Map(prepared.map((item) => [item.toolCallId, item]));
    for (const [index, card] of extractToolCardsCached(entry.message).entries()) {
      cards.push(card);
      toolContexts.set(card, {
        messageKey: entry.key,
        disclosureId: `${entry.key}:toolcard:${index}`,
      });
      const item = card.callId ? byCallId.get(card.callId) : undefined;
      if (item) {
        preparedByCard.set(card, item);
      }
    }
    return prepared;
  });
  const visibleActivity = activity.filter(
    (item) => !item.hideFromChannelProgress && !item.suppressChannelProgress,
  );
  const currentActivity = [
    ...new Map(
      visibleActivity
        .filter((item) => currentRunActivity.has(item))
        .map((item) => [item.toolCallId ?? item.itemId, item]),
    ).values(),
  ];
  const cardGroups = groupToolCalls(cards);
  const headline = selectActivityHeadline(currentActivity, cardGroups, preparedByCard);
  const visibleCalls = new Set(visibleActivity.map((item) => item.toolCallId ?? item.itemId));
  const activityDisclosureId = `activity:${firstGroup.key}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(firstGroup.key).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  const groupSummaryLabel = summarizeToolGroup(visibleActivity, {
    includeInlineOutcomes: activityExpanded,
    ownSessionLaunches: ownSessionLaunchCalls(cards),
  });
  const toolCardOverrides = new Map<ToolCard, ActivityOperationProps | null>();
  const approvalReviews = cards.flatMap((card) => readToolApprovalReviews(card.details));
  const recordedReviewOutcomes = cards.flatMap((card) => {
    const outcome = readToolApprovalReviewOutcome(card.details);
    return outcome ? [outcome] : [];
  });
  const reviewOutcome = resolveToolApprovalReviewOutcome(approvalReviews, recordedReviewOutcomes);
  // A settled step that completed with only routine nested calls is one operation:
  // its own row names it and keeps those calls underneath, where a count hides both.
  // Other outcomes and reviewed steps keep the counted row that carries their status.
  const [step] = cardGroups;
  const stepActivity = step ? preparedByCard.get(step.card) : undefined;
  const soleStep =
    !headline &&
    !reviewOutcome &&
    approvalReviews.length === 0 &&
    step !== undefined &&
    cardGroups.length === 1 &&
    step.children.length > 0 &&
    visibleCalls.size === 1 &&
    stepActivity?.status === "completed" &&
    visibleCalls.has(stepActivity.toolCallId ?? stepActivity.itemId);
  if (activityExpanded || soleStep) {
    for (const group of cardGroups) {
      if (group.children.length > 0) {
        for (const card of descendantCards(group)) {
          toolCardOverrides.set(card, null);
        }
        toolCardOverrides.set(group.card, { group, options: opts, contexts: toolContexts });
      }
    }
  }

  return {
    firstGroup,
    headline,
    groupSummaryLabel,
    currentActivity,
    visibleActivity,
    reviewOutcome,
    approvalReviews,
    cards,
    visibleCalls,
    activityDisclosureId,
    activityBodyId,
    activityExpanded,
    soleStep,
    toolCardOverrides,
  };
}

type ActivityState = NonNullable<ReturnType<typeof prepareActivityGroup>>;
type ActivityEntries = (
  overrides: () => ReadonlyMap<ToolCard, ActivityOperationProps | null>,
) => JSX.Element;

function ActivityGroupBody(props: {
  state: ActivityState;
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  renderEntries: ActivityEntries;
}) {
  const state = () => props.state;
  const overrides = createMemo(() => props.state.toolCardOverrides);
  const soleStep = () => state().soleStep && !props.options.bubbleMode;
  const compact = () => Boolean(props.options.bubbleMode);
  return (
    <div
      class={[
        "chat-activity-group",
        {
          "chat-activity-group--step": soleStep(),
          "chat-activity-group--bubble": compact(),
          "is-open": !soleStep() && state().activityExpanded,
        },
      ]}
      data-file-session-key={state().firstGroup.senderSession?.sessionKey ?? undefined}
    >
      <Show when={!soleStep()}>
        <button
          class="chat-inline-disclosure chat-activity-group__summary"
          type="button"
          aria-expanded={state().activityExpanded ? "true" : "false"}
          aria-controls={state().activityBodyId}
          onPointerEnter={syncToolDisclosureOverflow}
          onFocus={syncToolDisclosureOverflow}
          onClick={() =>
            props.options.onToggleToolMessageExpanded?.(
              state().activityDisclosureId,
              state().activityExpanded,
            )
          }
        >
          <ChatActivityHeadline
            scope={JSON.stringify([
              props.options.sessionKey,
              props.options.connectionEpoch,
              props.options.activityRunId,
            ])}
            activity={state().headline}
            summary={state().groupSummaryLabel}
            currentActivity={state().currentActivity}
            pluginToolIcons={props.options.pluginToolIcons}
            outcomes={describeToolGroup(state().visibleActivity)
              .outcomes.filter(({ kind }) => kind !== "failed" && kind !== "skipped")
              .map(({ label }) => label)}
          />{" "}
          <ChatToolReviewOutcome
            outcome={state().reviewOutcome}
            reviewer={state().approvalReviews[0]?.label}
            style={{ display: "contents" }}
          />
          <Show when={!state().activityExpanded}>
            <ChatToolOutcomeSummary
              cards={state().cards.filter(
                (card) => card.callId && state().visibleCalls.has(card.callId),
              )}
              includeCount={true}
              activity={state().visibleActivity}
              style={{ display: "contents" }}
            />
          </Show>
          <span class="chat-tool-row__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </button>
      </Show>
      <div
        class="chat-activity-group__body"
        id={soleStep() ? undefined : state().activityBodyId}
        hidden={!soleStep() && !state().activityExpanded}
      >
        <Show when={soleStep() || state().activityExpanded}>
          {(_visible) => props.renderEntries(overrides)}
        </Show>
      </div>
      <Show when={!props.options.bubbleMode || state().activityExpanded}>
        <BrowserTabPreviews previews={selectBrowserTabPreviews(props.groups, props.options)} />
      </Show>
    </div>
  );
}

export function ActivityGroupContent(props: {
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  presentation: "standalone" | "continuation";
  renderEntries: ActivityEntries;
}) {
  const state = createMemo(() => prepareActivityGroup(props.groups, props.options));
  return (
    <Show when={state()}>
      {(activity) => (
        <Show
          when={props.presentation === "standalone"}
          fallback={<ActivityGroupBody {...props} state={activity()} />}
        >
          <div
            class="chat-group tool chat-group--turn-block chat-group--activity chat-group--with-footer"
            data-chat-row-key={activity().firstGroup.key}
          >
            <div class="chat-group-messages">
              <ActivityGroupBody {...props} state={activity()} />
            </div>
          </div>
        </Show>
      )}
    </Show>
  );
}
