// Control UI chat module: per-topic accordion control strip (Phase 2, 02-03-5).
// Renders the durable topic boxes surfaced with chat history as a row of collapse/
// expand toggles. A live box is in the model's context verbatim; a collapsed box is
// folded to its summary. Clicking round-trips through the `accordion.toggle` gateway
// method (wired by the caller); this module only renders and emits the intent.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { ChatAccordionBox, ChatAccordionView } from "../types/chat-types.ts";

export type TopicAccordionProps = {
  // Gate: surfaced only when the unified-session control surface is active.
  enabled: boolean;
  accordion: ChatAccordionView | null;
  onToggleTopic?: (boxId: string, nextState: "live" | "collapsed") => void;
};

function boxDisplayLabel(box: ChatAccordionBox): string {
  const label = box.label?.trim();
  if (label) {
    return label;
  }
  const summary = box.summary?.trim();
  if (summary) {
    return summary.length > 40 ? `${summary.slice(0, 39)}…` : summary;
  }
  return t("chat.topics.untitled");
}

/** Render the per-topic collapse/expand strip, or `nothing` when it should be hidden. */
export function renderTopicAccordion(props: TopicAccordionProps) {
  const boxes = props.accordion?.boxes ?? [];
  // Flag off, no controller, or no topics yet → render the normal transcript untouched.
  if (!props.enabled || !props.onToggleTopic || boxes.length === 0) {
    return nothing;
  }
  const onToggle = props.onToggleTopic;
  return html`
    <div class="chat-topics" role="group" aria-label=${t("chat.topics.label")}>
      <span class="chat-topics__title">${t("chat.topics.label")}</span>
      ${boxes.map((box) => {
        const collapsed = box.state === "collapsed";
        const nextState = collapsed ? "live" : "collapsed";
        return html`
          <button
            type="button"
            class="chat-topic ${collapsed ? "chat-topic--collapsed" : "chat-topic--live"}"
            @click=${() => onToggle(box.id, nextState)}
            aria-pressed=${collapsed ? "false" : "true"}
            title=${collapsed ? t("chat.topics.expand") : t("chat.topics.collapse")}
            aria-label=${collapsed
              ? t("chat.topics.expandTopic", { topic: boxDisplayLabel(box) })
              : t("chat.topics.collapseTopic", { topic: boxDisplayLabel(box) })}
          >
            ${collapsed ? icons.chevronRight : icons.chevronDown}
            <span class="chat-topic__label">${boxDisplayLabel(box)}</span>
          </button>
        `;
      })}
    </div>
  `;
}
