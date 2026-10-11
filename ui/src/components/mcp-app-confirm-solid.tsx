import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { McpAppConfirm } from "./mcp-app-confirm.ts";
import "../styles/mcp-app-confirm.css";

export function McpAppConfirmation(props: { confirmation: McpAppConfirm; revision: number }) {
  const pending = () => {
    void props.revision;
    return props.confirmation.current;
  };
  return (
    <Show when={pending()} keyed>
      {(decision) => {
        const question = () =>
          t(decision.kind === "message" ? "mcpApp.confirmMessage" : "mcpApp.confirmFile");
        return (
          <div
            class="mcp-app-confirm"
            role="alertdialog"
            aria-label={`${decision.title}: ${question()}`}
            tabindex="-1"
            ref={props.confirmation.focusStrip}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Enter") {
                event.stopPropagation();
                if (event.key === "Escape" || event.target === event.currentTarget) {
                  event.preventDefault();
                  props.confirmation.finish(event.key === "Enter");
                }
              }
            }}
          >
            <div class="mcp-app-confirm__copy">
              <div class="mcp-app-confirm__title" title={decision.title}>
                {decision.title}
              </div>
              <div>{question()}</div>
              <div class="mcp-app-confirm__preview" title={decision.text}>
                {decision.text.length > 200 ? `${decision.text.slice(0, 200)}…` : decision.text}
              </div>
            </div>
            <div class="mcp-app-confirm__actions">
              <button
                class="mcp-app-confirm__accept"
                type="button"
                onClick={() => props.confirmation.finish(true)}
              >
                {t(decision.kind === "message" ? "mcpApp.sendMessage" : "mcpApp.openFile")}
              </button>
              <button type="button" onClick={() => props.confirmation.finish(false)}>
                {t("mcpApp.cancel")}
              </button>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
