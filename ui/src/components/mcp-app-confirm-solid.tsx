import { createMemo, onSettled, Show } from "solid-js";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import type { McpAppConfirm } from "./mcp-app-confirm.ts";
import "../styles/mcp-app-confirm.css";

registerMcpAppEnglish();

export function McpAppConfirmation(props: { confirmation: McpAppConfirm }) {
  const projected = createMemo(() => projectOwner(props.confirmation, (owner) => owner.read()));
  const pending = () => projected().read();
  return (
    <Show when={pending()} keyed>
      {(decision) => {
        let strip: HTMLDivElement | undefined;
        onSettled(() => {
          if (strip?.isConnected && props.confirmation.read() === decision) {
            strip.focus({ preventScroll: true });
          }
        });
        const question = () =>
          t(decision.kind === "message" ? "mcpApp.confirmMessage" : "mcpApp.confirmFile");
        return (
          <div
            class="mcp-app-confirm"
            role="alertdialog"
            aria-label={`${decision.title}: ${question()}`}
            tabindex="-1"
            ref={(element) => (strip = element)}
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
