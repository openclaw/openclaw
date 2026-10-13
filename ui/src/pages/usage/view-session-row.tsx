import { createMemo, Show } from "solid-js";
import "../../components/agent-row-chip.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function SessionBarRow(props: {
  sessionKey: string;
  displayLabel: string;
  meta: string[];
  agentId: string | undefined;
  valueLabel: string;
  isSelected: boolean;
  onSelect: (event: MouseEvent) => void;
}) {
  const copyIdentity = createMemo(() => ({ label: props.displayLabel }), {
    equals: (previous, next) => previous.label === next.label,
  });
  return (
    <div
      class={["session-bar-row", { selected: props.isSelected }]}
      onClick={(event: MouseEvent) => {
        if (event.target instanceof Element && event.target.closest("button")) {
          return;
        }
        props.onSelect(event);
      }}
      title={props.sessionKey}
    >
      <button
        type="button"
        class="session-bar-selection"
        aria-label={props.displayLabel}
        aria-pressed={props.isSelected ? "true" : "false"}
        onClick={(event) => props.onSelect(event)}
      >
        <span class="session-bar-label">
          <span class="session-bar-title">{props.displayLabel}</span>
          {props.agentId ? <openclaw-agent-row-chip prop:agentId={props.agentId} /> : undefined}
          {props.meta.length > 0 ? (
            <>
              {" "}
              <span class="session-bar-meta">{props.meta.join(" · ")}</span>{" "}
            </>
          ) : undefined}
        </span>
      </button>
      <div class="session-bar-actions">
        <Show when={copyIdentity()} keyed>
          {(_identity) => (
            <>
              {" "}
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  void handleCopyButton(event, props.displayLabel, t("usage.sessions.copy"));
                }}
              >
                <span data-copy-label>{t("usage.sessions.copy")}</span>
              </button>{" "}
            </>
          )}
        </Show>
        <div class="session-bar-value">{props.valueLabel}</div>
      </div>
    </div>
  );
}
