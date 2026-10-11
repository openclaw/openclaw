import { t } from "../lib/reactive/i18n.ts";

function LoadingMessage(props: { reply?: boolean; leading?: boolean }) {
  return (
    <div class={props.reply ? "assistant-panel-loading__message--reply" : undefined}>
      <div class="assistant-panel-loading__lines">
        <span />
        <span />
        {props.leading && <span />}
      </div>
    </div>
  );
}

export function AssistantPanelLoading() {
  return (
    <div
      class="assistant-panel-loading"
      role="status"
      aria-live="polite"
      aria-label={t("common.loading")}
      aria-busy="true"
    >
      <div class="assistant-panel-loading__content" aria-hidden="true">
        <div class="assistant-panel-loading__messages">
          <LoadingMessage leading />
          <LoadingMessage reply />
          <LoadingMessage />
        </div>
        <div class="assistant-panel-loading__composer" />
      </div>
    </div>
  );
}
