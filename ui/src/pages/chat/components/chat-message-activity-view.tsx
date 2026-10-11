import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { type ToolCallGroup, groupToolCalls } from "../../../../../src/chat/tool-call-grouping.js";
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
import {
  emptyLegacyContent as litNothing,
  LitContent,
  solidContent,
} from "../../../lit/solid-content.tsx";
import { ownSessionLaunchCalls } from "../chat-spawned-subagent.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { activityHeadline, selectActivityHeadline } from "./chat-activity-headline.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import {
  renderBrowserTabPreviews,
  renderToolCard,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.ts";
import { renderToolOutcomeSummary, renderToolReviewOutcome } from "./chat-tool-outcome-summary.ts";

type ToolContexts = ReadonlyMap<ToolCard, { messageKey: string; disclosureId: string }>;

function descendantCards(group: ToolCallGroup<ToolCard>) {
  const cards: ToolCard[] = [];
  const pending = [...group.children];
  for (const child of pending) {
    cards.push(child.card);
    pending.push(...child.children);
  }
  return cards;
}

function ActivityOperation(props: {
  group: ToolCallGroup<ToolCard>;
  options: NativeMessageGroupOptions;
  contexts: ToolContexts;
}) {
  const context = () => props.contexts.get(props.group.card)!;
  const expanded = () => props.options.isToolExpanded?.(context().disclosureId) ?? false;
  return (
    <LitContent
      value={renderToolCard(props.group.card, {
        ...props.options,
        messageKey: context().messageKey,
        expanded: expanded(),
        onToggleExpanded: () =>
          props.options.onToggleToolExpanded?.(context().disclosureId, expanded()),
        activityCards: [props.group.card, ...descendantCards(props.group)],
        children: props.group.children.length
          ? solidContent(ActivityOperationChildren, {
              groups: props.group.children,
              options: props.options,
              contexts: props.contexts,
              expanded: expanded(),
            })
          : undefined,
      })}
    />
  );
}

function ActivityOperationChildren(props: {
  groups: ToolCallGroup<ToolCard>[];
  options: NativeMessageGroupOptions;
  contexts: ToolContexts;
  expanded: boolean;
}) {
  return (
    <Show when={props.expanded}>
      <For
        each={props.groups}
        keyed={(group) => group.card.callId ?? props.contexts.get(group.card)!.disclosureId}
      >
        {(group) => (
          <ActivityOperation group={group()} options={props.options} contexts={props.contexts} />
        )}
      </For>
    </Show>
  );
}

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
  const toolCardOverrides = new Map<ToolCard, unknown>();
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
          toolCardOverrides.set(card, litNothing);
        }
        toolCardOverrides.set(
          group.card,
          solidContent(ActivityOperation, { group, options: opts, contexts: toolContexts }),
        );
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
type ActivityEntries = (overrides: () => ReadonlyMap<ToolCard, unknown>) => JSX.Element;

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
          <LitContent
            value={activityHeadline(
              JSON.stringify([
                props.options.sessionKey,
                props.options.connectionEpoch,
                props.options.activityRunId,
              ]),
              state().headline,
              state().groupSummaryLabel,
              state().currentActivity,
              props.options.pluginToolIcons,
              describeToolGroup(state().visibleActivity)
                .outcomes.filter(({ kind }) => kind !== "failed" && kind !== "skipped")
                .map(({ label }) => label),
            )}
          />
          <LitContent
            value={renderToolReviewOutcome(
              state().reviewOutcome,
              state().approvalReviews[0]?.label,
            )}
          />
          <Show when={!state().activityExpanded}>
            <LitContent
              value={renderToolOutcomeSummary(
                state().cards.filter(
                  (card) => card.callId && state().visibleCalls.has(card.callId),
                ),
                true,
                state().visibleActivity,
              )}
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
        <LitContent value={renderBrowserTabPreviews(props.groups, props.options)} />
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
          fallback={
            <ActivityGroupBody
              state={activity()}
              groups={props.groups}
              options={props.options}
              renderEntries={props.renderEntries}
            />
          }
        >
          <div
            class="chat-group tool chat-group--turn-block chat-group--activity chat-group--with-footer"
            data-chat-row-key={activity().firstGroup.key}
          >
            <div class="chat-group-messages">
              <ActivityGroupBody
                state={activity()}
                groups={props.groups}
                options={props.options}
                renderEntries={props.renderEntries}
              />
            </div>
          </div>
        </Show>
      )}
    </Show>
  );
}
