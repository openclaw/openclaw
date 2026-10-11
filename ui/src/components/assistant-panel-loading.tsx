import { t } from "../lib/reactive/i18n.ts";

export function AssistantPanelLoading() {
  return (
    <>
      <div
        class="assistant-panel-loading"
        role="status"
        aria-live="polite"
        aria-label={t("common.loading")}
        aria-busy="true"
      >
        <div class="assistant-panel-loading__content" aria-hidden="true">
          <div class="assistant-panel-loading__messages">
            <div>
              <div class="assistant-panel-loading__lines">
                <span />
                <span />
                <span />
              </div>
            </div>
            <div class="assistant-panel-loading__message--reply">
              <div class="assistant-panel-loading__lines">
                <span />
                <span />
              </div>
            </div>
            <div>
              <div class="assistant-panel-loading__lines">
                <span />
                <span />
              </div>
            </div>
          </div>
          <div class="assistant-panel-loading__composer" />
        </div>
      </div>
    </>
  );
}
