import type { BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { ChatBoardPanelSource } from "./chat-pane-panel-source.ts";
import type { ChatBoardPanel } from "./chat-pane-surfaces.tsx";
import { isSidebarSlotVisible } from "./sidebar-layout.ts";

/** Loaded with the panel; the retained pane still owns its view and all mutations. */
export function buildChatBoardPanel(
  {
    controls,
    owner,
    board,
    layout,
    session,
    connectionGeneration,
    pageWidgetName,
  }: ChatBoardPanelSource,
  widgetFrameUrl: BoardWidgetFrameUrl,
): Parameters<typeof ChatBoardPanel>[0] {
  const error = !board.provider.hasLoadedSnapshot && board.provider.loadError$.value;
  // Only the loaded board acknowledgment supplies a missing owner; its display key
  // must not replace the original session target (notably global versus a literal key).
  session.agentId ??= parseAgentSessionKey(board.snapshot.sessionKey)?.agentId;
  return {
    controls,
    error: error || undefined,
    surface: {
      onViewRef: (element) => {
        owner.boardView = element;
        return () => {
          if (owner.boardView === element) {
            owner.boardView = null;
          }
        };
      },
      active: {
        owner: owner.element,
        isPresented: () => isSidebarSlotVisible(layout, "dashboard") && owner.visuallyPresented,
        preview: () => !owner.presented && owner.connectionGeneration === connectionGeneration,
      },
      session,
      snapshot: board.provider.hasLoadedSnapshot ? board.snapshot : undefined,
      activeTabId: board.activeTabId,
      pageWidgetName,
      canMutate: board.provider.canMutate,
      canGrant: board.provider.canGrant,
      callbacks: {
        appViewGeneration: board.provider.appViewGeneration,
        applyOps: (ops) => board.provider.applyOps(ops),
        grant: (name, decision) => board.provider.grant(name, decision),
        selectTab: (tabId) => {
          owner.onFaceChange?.(owner.paneId, owner.sessionKey, "dashboard");
          owner.selectBoardTab(tabId);
        },
        frameLoadFailed: (name) => board.provider.refreshWidgetFrame(name),
        widgetAppView: (name, revision) => board.provider.widgetAppView(name, revision),
        refreshWidgetAppView: (name, revision) =>
          board.provider.refreshWidgetAppView(name, revision),
      } satisfies BoardViewCallbacks,
      widgetFrameUrl,
    },
  };
}
