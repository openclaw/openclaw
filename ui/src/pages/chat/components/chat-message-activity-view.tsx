import type { JSX } from "@solidjs/web";
import { dynamic } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { groupToolCalls, type ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
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
import { t } from "../../../lib/reactive/i18n.ts";
import { ownSessionLaunchCalls } from "../chat-spawned-subagent.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { selectActivityHeadline } from "./chat-activity-headline-selection.ts";
import { ChatActivityHeadline } from "./chat-activity-headline.solid.tsx";
import { descendantCards } from "./chat-message-activity-operation.tsx";
import type { ActivityOperationProps } from "./chat-message-bubble-options.ts";
import type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";
import { syncToolDisclosureOverflow } from "./chat-tool-card-chrome.tsx";
import { ToolReviewOutcome } from "./chat-tool-outcome-summary.solid.tsx";

export function prepareActivityGroup(
  groups: readonly MessageGroupData[],
  opts: NativeMessageGroupOptions,
  source?: {
    rootGroups: ReadonlyMap<ToolCard, ToolCallGroup<ToolCard>>;
    toolCardOverrides: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
    currentRunActivity: ReadonlySet<ReturnType<typeof readPreparedActivity>[number]>;
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
  const activity = entries.flatMap((entry) => {
    const prepared = readPreparedActivity(entry.message);
    if (
      !source &&
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
  // Segments have unique disclosure keys; the original group owns run membership.
  const activeRunActivity = source?.currentRunActivity ?? currentRunActivity;
  const currentActivity = [
    ...new Map(
      visibleActivity
        .filter((item) => activeRunActivity.has(item))
        .map((item) => [item.toolCallId ?? item.itemId, item]),
    ).values(),
  ];
  const cardGroups = source
    ? cards.flatMap((card) => {
        const root = source.rootGroups.get(card);
        return root ? [root] : [];
      })
    : groupToolCalls(cards);
  const headline = selectActivityHeadline(
    currentActivity,
    cardGroups,
    preparedByCard,
    opts.subagents?.subagentSessions,
  );
  const visibleCalls = new Set(visibleActivity.map((item) => item.toolCallId ?? item.itemId));
  const activityDisclosureId = `activity:${firstGroup.key}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(firstGroup.key).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  const groupSummaryLabel = summarizeToolGroup(visibleActivity, {
    ownSessionLaunches: ownSessionLaunchCalls(cards),
  });
  const toolCardOverrides = new Map<ToolCard, ActivityOperationProps | null>();
  const approvalReviews = cards.flatMap((card) => readToolApprovalReviews(card.details));
  const recordedReviewOutcomes = cards.flatMap((card) => {
    const outcome = readToolApprovalReviewOutcome(card.details);
    return outcome ? [outcome] : [];
  });
  const reviewOutcome = resolveToolApprovalReviewOutcome(approvalReviews, recordedReviewOutcomes);
  // A settled step with only routine nested calls is one operation: its own row
  // names it, carries its outcome, and keeps those calls underneath, where a count
  // hides all three. Blocked, skipped, and reviewed steps keep the counted row.
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
    (stepActivity?.status === "completed" || stepActivity?.status === "failed") &&
    visibleCalls.has(stepActivity.toolCallId ?? stepActivity.itemId);
  if (!source && (activityExpanded || soleStep || opts.inlineCommands)) {
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
  segmented?: boolean;
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

export function ActivityGroupContent(props: ActivityGroupContentProps) {
  const state = createMemo(() => prepareActivityGroup(props.groups, props.options));
  const InlineContent = dynamic(() => props.options.inlineCommands?.InlineActivityGroupContent);
  const body = () => (
    <Show
      when={props.options.inlineCommands}
      fallback={state() && <ActivityGroupBody {...props} state={state()!} />}
    >
      <InlineContent {...props} state={state()!} />
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
