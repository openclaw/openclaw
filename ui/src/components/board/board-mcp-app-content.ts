import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/view-types.ts";

type BoardMcpAppContentOptions = {
  accessNotice: TemplateResult | typeof nothing;
  active: boolean;
  appView?: BoardWidgetAppViewState;
  busy: boolean;
  loading: boolean;
  nearVisible: boolean;
  sessionKey: string;
  widget: BoardWidget;
  expired: () => void;
  remove: () => void;
  retry: () => void;
};

export function renderBoardMcpAppContent(options: BoardMcpAppContentOptions): TemplateResult {
  const { appView, widget } = options;
  const ready =
    appView?.status === "ready" && appView.expiresAtMs > Date.now() ? appView : undefined;
  const loading = html`<div class="board-widget__app-loading" data-test-id="board-mcp-app-loading">
    ${t("board.widget.appLoading")}
  </div>`;
  const view =
    ready && (!options.active || options.nearVisible)
      ? html`<mcp-app-view
          class="board-widget__mcp-app-view"
          .sessionKey=${options.sessionKey}
          .viewId=${ready.viewId}
          .fillContainer=${true}
          .title=${widget.title || widget.name}
          @openclaw-mcp-app-view-expired=${options.expired}
        ></mcp-app-view>`
      : !options.nearVisible || !appView
        ? loading
        : appView.status === "stale"
          ? html`<div class="board-widget__stale" data-test-id="board-mcp-app-stale">
              <strong>${t("board.widget.appStaleTitle")}</strong>
              <span>${t("board.widget.appStaleDetail")}</span>
              <div class="board-widget__grant-actions">
                <button
                  class="btn btn--small btn--primary"
                  type="button"
                  ?disabled=${options.loading}
                  @click=${options.retry}
                >
                  ${t("board.widget.retry")}
                </button>
                <button
                  class="btn btn--small"
                  type="button"
                  ?disabled=${options.busy}
                  @click=${options.remove}
                >
                  ${t("board.widget.remove")}
                </button>
              </div>
            </div>`
          : loading;
  return html`<div class="board-widget__mcp-app">${options.accessNotice}${view}</div>`;
}
