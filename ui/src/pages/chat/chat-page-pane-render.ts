import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ApplicationContext } from "../../app/context.ts";
import { nativeGatewaysCapability } from "../../app/native-gateways.runtime.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { RetainedSessionPresentation } from "./chat-page-retained-sessions.ts";
import type { PaneSessionChangeOptions } from "./chat-pane-shared.ts";
import type { RouteDraftComposerFocus } from "./route-draft-focus-handoff.ts";
import { routeDraft } from "./route-draft.ts";
import type { SessionChatRouteData } from "./route-loader.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";
import type { ChatSplitPane } from "./split-layout-types.ts";

type ChatPagePaneRenderOptions = RetainedSessionPresentation & {
  active: boolean;
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
  onFocusPane: (paneId: string) => void;
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
  sessionKeys: readonly string[];
  showGatewayPicker: boolean;
  splitMode: boolean;
  weight: number;
};

export function renderChatPagePaneCell(options: ChatPagePaneRenderOptions) {
  const pending = options.phase === "pending";
  const nativeGateways = options.showGatewayPicker ? nativeGatewaysCapability() : null;
  const sessions = options.context?.sessions?.state.result?.sessions ?? [];
  return html`
    <div
      class="chat-split-view__cell ${
        options.splitMode && options.active ? "chat-split-view__cell--active" : ""
      } ${options.narrow && !options.active ? "chat-split-view__cell--narrow-hidden" : ""}"
      aria-current=${options.splitMode && options.active ? "true" : nothing}
      style="flex: ${options.weight} 1 0"
      @pointerdown=${() => options.onFocusPane(options.pane.id)}
      @focusin=${() => options.onFocusPane(options.pane.id)}
    >
      <div class="chat-pane-cache" aria-busy=${pending ? "true" : "false"}>
        ${repeat(
          options.sessionKeys,
          (sessionKey) => sessionKey,
          (sessionKey) => {
            const selected =
              sessionKey === options.pane.sessionKey ||
              areUiSessionKeysEquivalent(sessionKey, options.pane.sessionKey);
            const visible =
              sessionKey === options.visualSessionKey ||
              areUiSessionKeysEquivalent(sessionKey, options.visualSessionKey);
            const onScreen = !options.narrow || options.active;
            const presented = (options.phase === "preview" ? selected : visible) && onScreen;
            const interactive = selected && visible && presented && !pending;
            const active = options.active && selected;
            const draft =
              active && interactive
                ? routeDraft(options.data, options.consumedDraftData, sessionKey)
                : undefined;
            const resolvedKey =
              resolveSessionKey(sessionKey, options.context?.gateway?.snapshot?.hello) ||
              sessionKey;
            const title = resolveSessionDisplayName(
              resolvedKey,
              sessions.find((row) => areUiSessionKeysEquivalent(row.key, resolvedKey)),
            );
            return html`<openclaw-chat-pane
              class="chat-pane-cache__pane ${visible ? "chat-pane-cache__pane--visible" : ""} ${
                active ? "chat-pane-cache__pane--active" : ""
              } ${options.splitMode ? "chat-split-view__pane" : ""}"
              data-mcp-app-owner-key=${JSON.stringify([options.ownerKey, sessionKey])}
              aria-hidden=${presented ? "false" : "true"}
              ?inert=${!interactive}
              .paneId=${options.pane.id}
              .presentationId=${JSON.stringify([options.pane.id, sessionKey])}
              .chatMessagesBySession=${options.chatMessagesBySession}
              .sessionSnapshotStore=${options.sessionSnapshotStore}
              .sessionKey=${sessionKey}
              .presented=${presented}
              .visuallyPresented=${visible && onScreen}
              .preparing=${pending && selected && !visible && onScreen}
              .active=${active}
              .draft=${draft}
              .focusComposer=${options.draftFocus.shouldFocusPane(
                active && interactive,
                draft,
                sessionKey,
                options.data,
              )}
              .dashboardExpanded=${options.data?.dashboardExpanded === true}
              .routeFace=${options.data?.face ?? "chat"}
              .paneTitle=${title}
              .narrow=${options.narrow}
              .mergedChrome=${options.mergedChrome && options.active}
              .navDrawerOpen=${options.navDrawerOpen && options.active}
              .nativeGateways=${nativeGateways}
              .gatewaysSnapshot=${nativeGateways?.snapshot ?? null}
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
            ></openclaw-chat-pane>`;
          },
        )}
      </div>
    </div>
  `;
}
