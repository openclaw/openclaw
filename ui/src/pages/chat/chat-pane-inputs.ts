import type { ChatPaneRuntime } from "./chat-pane-render.ts";

/** The native host registration and retained view share one input contract. */
export const chatPaneProperties = {
  mcpAppLaunch: { default: undefined },
  paneId: { default: "single" },
  paneLabel: { default: undefined },
  presentationId: { default: "single" },
  chatMessagesBySession: { default: undefined },
  sessionSnapshotStore: { default: undefined },
  sessionKey: { default: "" },
  routeLoadingSkeleton: { default: false },
  routeResolutionPending: { default: false },
  agentId: { default: undefined },
  inputRegion: { default: "page" as const },
  compact: { default: false },
  onBackToSubagents: { default: undefined },
  workContext: { default: undefined },
  visuallyPresented: { default: true },
  presented: { default: true },
  active: { default: false },
  draft: { default: undefined },
  focusComposer: { default: false },
  dashboardExpanded: { default: false },
  routeFace: { default: undefined },
  onFaceChange: { default: undefined },
  onFocusPane: { default: undefined },
  onPaneSessionChange: { default: undefined },
  onSessionDeleted: { default: undefined },
  narrow: { default: false },
  mergedChrome: { default: false },
  navDrawerOpen: { default: false },
  gatewayStatus: { default: null },
  onboarding: { default: false },
  onOpenSplitView: { default: undefined },
  onSplitDown: { default: undefined },
  onSplitRight: { default: undefined },
  onClosePane: { default: undefined },
  boardProvider: { default: undefined },
} satisfies { [Key in keyof ChatPaneRuntime]?: { default: ChatPaneRuntime[Key] } };

export type ChatPaneProps = Pick<ChatPaneRuntime, keyof typeof chatPaneProperties>;

// SAFETY: This checked literal owns every enumerable input key.
export const chatPanePropertyKeys = Object.keys(chatPaneProperties) as (keyof ChatPaneProps)[];
