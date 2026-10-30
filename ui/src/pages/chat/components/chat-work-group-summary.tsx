import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { describeToolGroup, readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import {
  extractToolCardsCached,
  projectToolCardActivityOutcome,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { formatDurationLong } from "../../../lib/format-duration.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { BrowserTabPreviews } from "./chat-browser-tab-previews.tsx";
import { syncToolDisclosureOverflow } from "./chat-tool-card-chrome.tsx";
import type { BrowserTabPreview } from "./chat-tool-cards.ts";

type WorkGroupSummaryItem = {
  key: string;
  durationMs: number | null;
  groups: readonly MessageGroup[];
};
type WorkGroupSummaryOptions = {
  mediaReadAllowed?: boolean;
  expanded: boolean;
  onToggle: () => void;
  presentation?: "standalone" | "continuation";
  browserTabPreviews?: readonly BrowserTabPreview[];
  bubbleMode?: boolean;
};

function prepareWorkGroupSummary(item: WorkGroupSummaryItem) {
  const duration = formatDurationLong(item.durationMs);
  const entries = item.groups.flatMap((group) =>
    group.messages.map(({ message }) => ({
      cards: extractToolCardsCached(message),
      // An explicit empty projection also owns the message: its calls were hidden.
      activity: Array.isArray(asOptionalRecord(message)?.activity)
        ? readPreparedActivity(message)
        : undefined,
    })),
  );
  const prepared = entries.flatMap(({ cards, activity }) =>
    activity === undefined ? [] : [{ cards, activity }],
  );
  const preparedCallIds = new Set(
    prepared.flatMap(({ cards, activity }) => [
      ...cards.flatMap((card) => (card.callId ? [card.callId] : [])),
      ...activity.map((activityItem) => activityItem.toolCallId ?? activityItem.itemId),
    ]),
  );
  const cardsById = new Map(
    entries.flatMap((entry) => entry.cards).map((card) => [card.callId ?? card, card]),
  );
  const cards = [...cardsById.values()];
  const rawCards = new Set(
    entries.filter((entry) => entry.activity === undefined).flatMap((entry) => entry.cards),
  );
  const fallback = cards.filter(
    (card) => rawCards.has(card) && (!card.callId || !preparedCallIds.has(card.callId)),
  );
  const activity = prepared.flatMap((entry) => entry.activity);
  for (const [index, card] of fallback.entries()) {
    const display = resolveToolDisplayIdentity(unwrapToolCallForDisplay(card).name);
    activity.push({
      itemId: `work-summary-raw:${index}`,
      toolCallId: card.callId,
      kind: "tool",
      phase: "end",
      title: display.name,
      name: display.name,
      ...projectToolCardActivityOutcome(resolveToolCardOutcome(card, false)),
    });
  }
  const label = duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  const summary = describeToolGroup(activity);
  const total = summary.total;
  const outcomes = summary.outcomes.filter(({ kind }) => kind !== "failed" && kind !== "skipped");
  // The reply that follows owns the outcome; failures the agent recovered from stay on their rows.
  return { label, total, outcomes };
}

function WorkGroupSummaryBody(props: {
  summary: ReturnType<typeof prepareWorkGroupSummary>;
  options: WorkGroupSummaryOptions;
}) {
  let disclosureContent: HTMLSpanElement | undefined;
  const syncOverflow = (event: Event) => syncToolDisclosureOverflow(event, disclosureContent);
  const compact = () => props.options.bubbleMode;
  return (
    <div
      class={[
        "chat-activity-group chat-work-group",
        {
          "is-open": props.options.expanded,
          "chat-activity-group--bubble": compact(),
        },
      ]}
    >
      <button
        class="chat-inline-disclosure chat-activity-group__summary"
        type="button"
        aria-expanded={props.options.expanded ? "true" : "false"}
        onPointerEnter={syncOverflow}
        onFocus={syncOverflow}
        onClick={() => props.options.onToggle()}
      >
        <span
          ref={(element) => (disclosureContent = element)}
          class="chat-tool-disclosure__content"
        >
          <span class="chat-activity-group__label">{props.summary.label}</span>
        </span>
        <Show when={props.options.expanded && props.summary.total > 0}>
          <span class="chat-work-group__total">
            {" · "}
            {t(`chat.workRun.toolCalls${props.summary.total === 1 ? "One" : "Many"}`, {
              count: String(props.summary.total),
            })}
          </span>
        </Show>
        <For each={props.summary.outcomes} keyed={(outcome) => outcome.kind}>
          {(outcome) => (
            <span class="chat-activity-group__outcome muted">
              {" · "}
              {outcome().label}
            </span>
          )}
        </For>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </button>
      <div class="chat-work-group__separator" aria-hidden="true" />
      <Show when={!props.options.expanded && !props.options.bubbleMode}>
        <BrowserTabPreviews
          previews={props.options.browserTabPreviews}
          mediaReadAllowed={props.options.mediaReadAllowed}
        />
      </Show>
    </div>
  );
}

/** Completed work keeps elapsed time and outcomes above the expandable narration. */
export function WorkGroupSummary(props: {
  item: WorkGroupSummaryItem;
  options: WorkGroupSummaryOptions;
}) {
  const summary = createMemo(() => prepareWorkGroupSummary(props.item));
  return (
    <Show
      when={props.options.presentation === "continuation"}
      fallback={
        <div
          class="chat-group tool chat-group--turn-block chat-group--work"
          data-chat-row-key={props.item.key}
        >
          <div class="chat-group-messages">
            <WorkGroupSummaryBody summary={summary()} options={props.options} />
          </div>
        </div>
      }
    >
      <WorkGroupSummaryBody summary={summary()} options={props.options} />
    </Show>
  );
}
