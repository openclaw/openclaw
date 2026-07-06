import { consume } from "@lit/context";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import "../../components/resizable-divider.ts";
import { t } from "../../i18n/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import {
  closePane,
  createSplitLayout,
  findPane,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  splitPaneDown,
  splitPaneRight,
  type ChatSplitLayout,
  type ChatSplitPane,
} from "./split-layout.ts";

type ChatRouteData = {
  sessionKey: string;
  draft?: string;
};

const NARROW_SPLIT_QUERY = "(max-width: 1099px)";

export class ChatPage extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @property({ attribute: false }) data!: ChatRouteData;
  @state() private layout: ChatSplitLayout | undefined;
  @state() private narrow = false;

  private mediaQuery: MediaQueryList | null = null;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.layout = loadSettings().chatSplitLayout;
    this.mediaQuery = window.matchMedia(NARROW_SPLIT_QUERY);
    this.narrow = this.mediaQuery.matches;
    this.mediaQuery.addEventListener("change", this.handleViewportChange);
    this.syncRouteToActivePane();
  }

  override disconnectedCallback() {
    this.mediaQuery?.removeEventListener("change", this.handleViewportChange);
    this.mediaQuery = null;
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<PropertyKey, unknown>) {
    if (changedProperties.has("data")) {
      this.syncRouteToActivePane();
    }
  }

  private readonly handleViewportChange = (event: MediaQueryListEvent) => {
    this.narrow = event.matches;
  };

  // Route and active pane mirror each other: route changes land in the active
  // pane here, and pane-side changes call updateRoute. The equality guards on
  // both paths are what keep that from looping.
  private syncRouteToActivePane() {
    const layout = this.layout;
    const sessionKey = this.data?.sessionKey?.trim();
    if (!layout || !sessionKey) {
      return;
    }
    const activePane = findPane(layout, layout.activePaneId)?.pane;
    if (!activePane || activePane.sessionKey === sessionKey) {
      return;
    }
    this.persistLayout(setPaneSession(layout, activePane.id, sessionKey));
  }

  private persistLayout(layout: ChatSplitLayout | undefined) {
    this.layout = layout;
    patchSettings({ chatSplitLayout: layout });
  }

  private updateRoute(sessionKey: string, replace = false) {
    if (this.data?.sessionKey === sessionKey) {
      return;
    }
    const options = { search: searchForSession(sessionKey) };
    if (replace) {
      this.context.replace("chat", options);
    } else {
      this.context.navigate("chat", options);
    }
  }

  private readonly handleFocusPane = (paneId: string) => {
    const layout = this.layout;
    if (!layout || layout.activePaneId === paneId) {
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane) {
      return;
    }
    this.persistLayout(setActivePane(layout, paneId));
    this.updateRoute(pane.sessionKey, true);
  };

  private readonly handlePaneSessionChange = (
    paneId: string,
    sessionKey: string,
    options?: { replace?: boolean },
  ) => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return;
    }
    const layout = this.layout;
    if (!layout) {
      this.updateRoute(trimmed, options?.replace);
      return;
    }
    const pane = findPane(layout, paneId)?.pane;
    if (!pane || pane.sessionKey === trimmed) {
      return;
    }
    this.persistLayout(setPaneSession(layout, paneId, trimmed));
    if (layout.activePaneId === paneId) {
      this.updateRoute(trimmed, options?.replace);
    }
  };

  private readonly openSplitView = () => {
    const sessionKey = this.data?.sessionKey?.trim();
    if (sessionKey) {
      this.persistLayout(createSplitLayout(sessionKey));
    }
  };

  private readonly handleSplitRight = (paneId: string) => {
    const layout = this.layout;
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (!layout || !pane) {
      return;
    }
    this.persistLayout(splitPaneRight(layout, paneId, pane.sessionKey));
  };

  private readonly handleSplitDown = (paneId: string) => {
    const layout = this.layout;
    const pane = layout ? findPane(layout, paneId)?.pane : null;
    if (!layout || !pane) {
      return;
    }
    this.persistLayout(splitPaneDown(layout, paneId, pane.sessionKey));
  };

  private readonly handleClosePane = (paneId: string) => {
    const layout = this.layout;
    if (!layout) {
      return;
    }
    const survivingPane = panesOf(layout).find((pane) => pane.id !== paneId);
    const next = closePane(layout, paneId);
    this.persistLayout(next);
    if (!next && survivingPane) {
      this.updateRoute(survivingPane.sessionKey, true);
      return;
    }
    if (next) {
      const activePane = findPane(next, next.activePaneId)?.pane;
      if (activePane) {
        this.updateRoute(activePane.sessionKey, true);
      }
    }
  };

  private renderPane(pane: ChatSplitPane, active: boolean, weight: number) {
    // Narrow viewports render only the active pane, so splitting there would
    // create invisible panes; keep session switching and close available.
    const canSplit = !this.narrow;
    return html`
      <openclaw-chat-pane
        class="chat-split-view__pane"
        style="flex: ${weight} 1 0"
        .paneId=${pane.id}
        .sessionKey=${pane.sessionKey}
        .active=${active}
        .chrome=${"pane"}
        .draft=${active ? this.data?.draft : undefined}
        .onFocusPane=${this.handleFocusPane}
        .onPaneSessionChange=${this.handlePaneSessionChange}
        .onSplitRight=${canSplit ? this.handleSplitRight : undefined}
        .onSplitDown=${canSplit ? this.handleSplitDown : undefined}
        .onClosePane=${this.handleClosePane}
      ></openclaw-chat-pane>
    `;
  }

  private renderSplitLayout(layout: ChatSplitLayout) {
    if (this.narrow) {
      const activePane = findPane(layout, layout.activePaneId)?.pane;
      return activePane
        ? html`<div class="chat-split-view chat-split-view--narrow">
            ${this.renderPane(activePane, true, 1)}
          </div>`
        : nothing;
    }
    return html`
      <div class="chat-split-view">
        ${repeat(
          layout.columns,
          (column) => column.id,
          (column, columnIndex) => html`
            <div
              class="chat-split-view__column"
              style="flex: ${layout.columnWeights[columnIndex]} 1 0"
            >
              ${repeat(
                column.panes,
                (pane) => pane.id,
                (pane, paneIndex) => html`
                  ${this.renderPane(
                    pane,
                    pane.id === layout.activePaneId,
                    column.paneWeights[paneIndex],
                  )}
                  ${paneIndex < column.panes.length - 1
                    ? html`
                        <resizable-divider
                          orientation="horizontal"
                          .splitRatio=${column.paneWeights[paneIndex] /
                          (column.paneWeights[paneIndex] + column.paneWeights[paneIndex + 1])}
                          .minRatio=${0.15}
                          .maxRatio=${0.85}
                          .label=${t("nav.resize")}
                          @resize=${(event: CustomEvent<{ splitRatio: number }>) => {
                            const current = this.layout;
                            if (current) {
                              this.persistLayout(
                                resizePanes(current, column.id, paneIndex, event.detail.splitRatio),
                              );
                            }
                          }}
                        ></resizable-divider>
                      `
                    : nothing}
                `,
              )}
            </div>
            ${columnIndex < layout.columns.length - 1
              ? html`
                  <resizable-divider
                    .splitRatio=${layout.columnWeights[columnIndex] /
                    (layout.columnWeights[columnIndex] + layout.columnWeights[columnIndex + 1])}
                    .minRatio=${0.15}
                    .maxRatio=${0.85}
                    .label=${t("nav.resize")}
                    @resize=${(event: CustomEvent<{ splitRatio: number }>) => {
                      const current = this.layout;
                      if (current) {
                        this.persistLayout(
                          resizeColumns(current, columnIndex, event.detail.splitRatio),
                        );
                      }
                    }}
                  ></resizable-divider>
                `
              : nothing}
          `,
        )}
      </div>
    `;
  }

  override render() {
    if (this.layout) {
      return this.renderSplitLayout(this.layout);
    }
    return html`
      <openclaw-chat-pane
        .paneId=${"single"}
        .sessionKey=${this.data?.sessionKey ?? ""}
        .active=${true}
        .chrome=${"none"}
        .draft=${this.data?.draft}
        .onFocusPane=${this.handleFocusPane}
        .onPaneSessionChange=${this.handlePaneSessionChange}
        .onOpenSplitView=${this.narrow ? undefined : this.openSplitView}
      ></openclaw-chat-pane>
    `;
  }
}

if (!customElements.get("openclaw-chat-page")) {
  customElements.define("openclaw-chat-page", ChatPage);
}
