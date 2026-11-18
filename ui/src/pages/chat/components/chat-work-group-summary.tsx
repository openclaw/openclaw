import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { syncToolDisclosureOverflow } from "./chat-tool-card-chrome.tsx";

type WorkGroupSummaryItem = {
  key: string;
  durationMs: number | null;
};
type WorkGroupSummaryOptions = {
  expanded: boolean;
  onToggle: () => void;
  presentation?: "standalone" | "continuation";
  bubbleMode?: boolean;
};

function WorkGroupSummaryBody(props: { label: string; options: WorkGroupSummaryOptions }) {
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
          <span class="chat-activity-group__label">{props.label}</span>
        </span>
        <span class="chat-inline-disclosure__chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
    </div>
  );
}

/** The same elapsed-time label identifies completed work in either disclosure state. */
export function WorkGroupSummary(props: {
  item: WorkGroupSummaryItem;
  options: WorkGroupSummaryOptions;
}) {
  const label = createMemo(() => {
    const duration = formatDurationCompact(props.item.durationMs);
    return duration ? t("chat.workRun.workedFor", { duration }) : t("chat.workRun.worked");
  });
  return (
    <Show
      when={props.options.presentation === "continuation"}
      fallback={
        <div
          class="chat-group tool chat-group--turn-block chat-group--work"
          data-chat-row-key={props.item.key}
        >
          <div class="chat-group-messages">
            <WorkGroupSummaryBody label={label()} options={props.options} />
          </div>
        </div>
      }
    >
      <WorkGroupSummaryBody label={label()} options={props.options} />
    </Show>
  );
}
