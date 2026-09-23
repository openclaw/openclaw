import { html, noChange, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import "../../components/resizable-divider.ts";
import { repeat } from "lit/directives/repeat.js";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import { t } from "../../i18n/index.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { DropIndicator } from "./chat-page-drop-indicator.ts";
import type { PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import type { RouteDraftComposerFocus } from "./route-draft-focus-handoff.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { ChatSplitLayout, ChatSplitColumn, ChatSplitPane } from "./split-layout-types.ts";
import { splitRatio, splitWeight } from "./split-layout.ts";

type ChatPagePaneRenderOptions = {
  active: boolean;
  presented: boolean;
  chatMessagesBySession: ChatMessageCache;
  sessionSnapshotStore: SessionSnapshotStore;
  consumedDraftData: SessionChatRouteData | null;
  context?: ApplicationContext;
  data?: SessionChatRouteData;
  draftFocus: RouteDraftComposerFocus;
  mergedChrome: boolean;
  narrow: boolean;
  navDrawerOpen: boolean;
  onboarding: boolean;
  onClosePane?: (paneId: string) => void;
  onFaceChange: (paneId: string, sessionKey: string, face: BoardFace) => void;
  onFocusPane: (paneId: string, intent?: "review-edit") => void;
  onOpenSplitView?: () => void;
  onPaneSessionChange: (
    paneId: string,
    sourceSessionKey: string,
    sessionKey: string,
    options?: PaneSessionChangeOptions,
  ) => boolean;
  onSessionDeleted: (
    paneId: string,
    sessionKey: string,
    replacementSessionKey: string,
    preserveDraft?: boolean,
  ) => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  ownerKey: string;
  pane: ChatSplitPane;
  sessionSlots: readonly (string | undefined)[];
  splitMode: boolean;
  weight: number;
};

export function renderChatPagePaneCell(options: ChatPagePaneRenderOptions) {
  const sessions = options.context?.sessions?.presentation.result?.sessions ?? [];
  return html`
    <div
      class="chat-split-view__cell ${
        options.splitMode && options.active ? "chat-split-view__cell--active" : ""
      } ${options.narrow && !options.active ? "chat-split-view__cell--narrow-hidden" : ""}"
      aria-current=${options.splitMode && options.active ? "true" : nothing}
      style="flex: ${options.narrow ? 1 : options.weight} 1 0"
      @pointerdown=${() => options.onFocusPane(options.pane.id)}
      @focusin=${() => options.onFocusPane(options.pane.id)}
    >
      <div class="chat-pane-cache">
        ${options.sessionSlots.map((sessionKey) => {
          if (sessionKey === undefined) {
            return nothing;
          }
          const visible =
            sessionKey === options.pane.sessionKey ||
            areUiSessionKeysEquivalent(sessionKey, options.pane.sessionKey);
          const presented = options.presented && visible && (!options.narrow || options.active);
          const active = options.active && visible;
          const routeData =
            options.data && areUiSessionKeysEquivalent(sessionKey, options.data.sessionKey)
              ? options.data
              : undefined;
          const draft = active
            ? routeDraft(options.data, options.consumedDraftData, sessionKey)
            : undefined;
          const resolvedKey =
            resolveSessionKey(sessionKey, options.context?.gateway?.snapshot?.hello) || sessionKey;
          const title = resolveSessionDisplayName(
            resolvedKey,
            sessions.find((row) => areUiSessionKeysEquivalent(row.key, resolvedKey)),
          );
          if (options.context && readDeletedSessionStartup(options.context, sessionKey)) {
            return keyed(
              sessionKey,
              html`<openclaw-pending-session-create
                class="chat-pane-cache__pane ${visible ? "chat-pane-cache__pane--visible" : ""}
                ${active ? "chat-pane-cache__pane--active" : ""}
                ${options.splitMode ? "chat-split-view__pane" : ""}"
                aria-hidden=${String(!presented)}
                ?inert=${!presented}
                .context=${options.context}
                .sessionKey=${sessionKey}
              ></openclaw-pending-session-create>`,
            );
          }
          return keyed(
            sessionKey,
            html`<openclaw-chat-pane
              class="chat-pane-cache__pane ${
                visible ? "chat-pane-cache__pane--visible" : ""
              } ${active ? "chat-pane-cache__pane--active" : ""} ${
                options.splitMode ? "chat-split-view__pane" : ""
              }"
              data-mcp-app-owner-key=${JSON.stringify([options.ownerKey, sessionKey])}
              aria-hidden=${presented ? "false" : "true"}
              ?inert=${!presented}
              .paneId=${options.pane.id}
              .presentationId=${JSON.stringify([options.pane.id, sessionKey])}
              .chatMessagesBySession=${options.chatMessagesBySession}
              .sessionSnapshotStore=${options.sessionSnapshotStore}
              .sessionKey=${sessionKey}
              .routeLoadingSkeleton=${routeData?.routeLoadingSkeleton ?? noChange}
              .presented=${presented}
              .visuallyPresented=${presented}
              .active=${active}
              .draft=${draft}
              .focusComposer=${options.draftFocus.shouldFocusPane(
                active,
                draft,
                sessionKey,
                options.data,
              )}
              .dashboardExpanded=${routeData ? routeData.dashboardExpanded === true : noChange}
              .routeFace=${routeData ? (routeData.face ?? "chat") : noChange}
              .paneTitle=${title}
              .narrow=${options.narrow}
              .mergedChrome=${options.mergedChrome && active}
              .navDrawerOpen=${options.navDrawerOpen && active}
              .onboarding=${options.onboarding}
              .onOpenSplitView=${options.onOpenSplitView}
              .onSplitDown=${options.onSplitDown}
              .onSplitRight=${options.onSplitRight}
              .onClosePane=${options.onClosePane}
              .onFocusPane=${options.onFocusPane}
              .onPaneSessionChange=${(
                paneId: string,
                nextSessionKey: string,
                paneOptions?: PaneSessionChangeOptions,
              ) => options.onPaneSessionChange(paneId, sessionKey, nextSessionKey, paneOptions)}
              .onSessionDeleted=${options.onSessionDeleted}
              .onFaceChange=${options.onFaceChange}
            ></openclaw-chat-pane>`,
          );
        })}
      </div>
    </div>
  `;
}

export function renderChatPageSplitLayout(
  layout: ChatSplitLayout,
  options: {
    narrow: boolean;
    renderPane: (column: ChatSplitColumn, pane: ChatSplitPane, weight: number) => unknown;
    onResizePanes: (columnId: string, paneIndex: number, ratio: number) => void;
    onResizeColumns: (columnIndex: number, ratio: number) => void;
    onResizeEnd: () => void;
  },
) {
  return html`
    <div class="chat-split-view ${options.narrow ? "chat-split-view--narrow" : ""}">
      ${repeat(
        layout.columns,
        (column) => column.id,
        (column, columnIndex) => html`
          <div
            class="chat-split-view__column ${
              options.narrow && !column.panes.some((pane) => pane.id === layout.activePaneId)
                ? "chat-split-view__column--narrow-hidden"
                : ""
            }"
            style="flex: ${
              options.narrow
                ? 1
                : splitWeight(layout.columnWeights, columnIndex, "rendered split column weight")
            } 1 0"
          >
            ${repeat(
              column.panes,
              (pane) => pane.id,
              (pane, paneIndex) => html`
                ${options.renderPane(column, pane, splitWeight(column.paneWeights, paneIndex, "rendered split pane weight"))}
                ${
                  !options.narrow && paneIndex < column.panes.length - 1
                    ? html`
                        <resizable-divider
                          orientation="horizontal"
                          .splitRatio=${splitRatio(
                            column.paneWeights,
                            paneIndex,
                            "split pane weight",
                          )}
                          .minRatio=${0.15}
                          .maxRatio=${0.85}
                          .label=${t("nav.resize")}
                          @resize=${(event: CustomEvent<{ splitRatio: number }>) => options.onResizePanes(column.id, paneIndex, event.detail.splitRatio)}
                          @resize-end=${options.onResizeEnd}
                        ></resizable-divider>
                      `
                    : nothing
                }
              `,
            )}
          </div>
          ${
            !options.narrow && columnIndex < layout.columns.length - 1
              ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio(
                      layout.columnWeights,
                      columnIndex,
                      "split column weight",
                    )}
                    .minRatio=${0.15}
                    .maxRatio=${0.85}
                    .label=${t("nav.resize")}
                    @resize=${(event: CustomEvent<{ splitRatio: number }>) => options.onResizeColumns(columnIndex, event.detail.splitRatio)}
                    @resize-end=${options.onResizeEnd}
                  ></resizable-divider>
                `
              : nothing
          }
        `,
      )}
    </div>
  `;
}

export function renderChatPageBody(content: unknown, indicator: DropIndicator | null) {
  return html`<div class="chat-split-view__drop-container">
    ${content}${
      indicator
        ? html`<div
            class="chat-split-view__drop-indicator ${
              indicator.zone.kind === "center" ? "chat-split-view__drop-indicator--center" : ""
            }"
            style=${`left: ${indicator.rect.left}px; top: ${indicator.rect.top}px; width: ${indicator.rect.width}px; height: ${indicator.rect.height}px;`}
          >
            <span class="chat-split-view__drop-indicator-label"
              >${
                indicator.zone.kind === "center"
                  ? t("chat.splitView.dropOpenHere")
                  : t("chat.splitView.dropSplit")
              }</span
            >
          </div>`
        : nothing
    }
  </div>`;
}

export function renderPendingChatPage(
  context: ApplicationContext,
  sessionKey: string,
  presented: boolean,
) {
  if (!presented) {
    return nothing;
  }
  return html`<openclaw-pending-session-create
    .context=${context}
    .sessionKey=${sessionKey}
  ></openclaw-pending-session-create>`;
}
