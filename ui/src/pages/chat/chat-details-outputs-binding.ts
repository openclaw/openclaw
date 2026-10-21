import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatDetailsOutputsIcons, ChatDetailsProps } from "./components/chat-details-types.ts";
import {
  isCurrentSessionWorkspace,
  loadSessionWorkspaceArtifacts,
  retainSessionWorkspaceArtifacts,
  selectSessionWorkspacePreview,
} from "./components/chat-session-workspace-state.ts";
import type { SessionWorkspaceState } from "./components/chat-session-workspace-types.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import { openSlot } from "./sidebar-layout.ts";

type OutputsContext = {
  gateway: () => ApplicationGateway;
  state: () => ChatPageHost | undefined;
  isConnected: () => boolean;
  presented: () => boolean;
  presentation: () => NonNullable<
    Parameters<typeof createSessionWorkspaceProps>[1]
  >["presentation"];
  readBoard: () => ResolvedBoardView;
  showDashboard: () => void;
};

export function createDetailsOutputsBinding(
  context: OutputsContext,
  state: ChatPageHost,
  workspace: SessionWorkspaceState,
  provider: ResolvedBoardView["provider"],
) {
  const client = state.client;
  const connected = state.connected;
  const sessionId = state.currentSessionId;
  const gateway = context.gateway();
  const scope = gatewayPresentationScope(gateway);
  const current = () =>
    context.isConnected() &&
    context.presented() &&
    context.state() === state &&
    state.client === client &&
    state.connected === connected &&
    state.currentSessionId === sessionId &&
    context.gateway() === gateway &&
    gatewayPresentationScope(gateway) === scope &&
    isCurrentSessionWorkspace(state, workspace);
  let release: (() => void) | undefined;
  const stop = () => {
    release?.();
    release = undefined;
  };
  return {
    state,
    workspace,
    provider,
    client,
    connected,
    sessionId,
    scope,
    stop,
    retain: () => {
      stop();
      if (!current()) {
        return undefined;
      }
      const releaseDemand = retainSessionWorkspaceArtifacts(state, "assistant");
      release = releaseDemand;
      return () => {
        if (release === releaseDemand) {
          stop();
        }
      };
    },
    onRetryArtifacts: () => {
      if (current()) {
        void loadSessionWorkspaceArtifacts(state, true, "assistant");
      }
    },
    onOpenArtifact: (id: string) => {
      if (!current()) {
        return;
      }
      // Consume the native reader operation without changing its draft/resource identity.
      createSessionWorkspaceProps(state, {
        presentation: context.presentation(),
        draftScope: state.sessionWorkspaceDraftScope,
        draftContext: state.sessionWorkspaceDraftContext,
      }).onOpenArtifact(id);
    },
    onViewAll: () => {
      if (!current()) {
        return;
      }
      selectSessionWorkspacePreview(state, null);
      state.updateSidebarLayout(openSlot(state.sidebarLayout, "workspace"));
    },
    onOpenDashboard: () => {
      if (!current()) {
        return;
      }
      const board = context.readBoard();
      if (board.provider === provider && board.available && board.hasBoard) {
        context.showDashboard();
      }
    },
  };
}

export type DetailsOutputsBinding = ReturnType<typeof createDetailsOutputsBinding>;

export function projectDetailsOutputs(
  binding: DetailsOutputsBinding,
  workspace: SessionWorkspaceState,
  board: ResolvedBoardView,
  boardReady: boolean,
  icons: ChatDetailsOutputsIcons,
): Pick<ChatDetailsProps, "outputs" | "retainOutputs"> {
  const artifacts = workspace.assistantArtifacts;
  return {
    retainOutputs: binding.retain,
    outputs: {
      ...icons,
      artifacts: artifacts?.resolved ? artifacts.items : null,
      artifactsLoading: artifacts?.loading ?? false,
      artifactsError: artifacts?.error ?? null,
      dashboard: !board.available
        ? null
        : boardReady && board.provider.hasLoadedSnapshot
          ? board.hasBoard
            ? {
                title:
                  board.snapshot.tabs.find((tab) => tab.tabId === board.activeTabId)?.title ??
                  t("outputs.dashboard"),
                onOpen: binding.onOpenDashboard,
              }
            : null
          : undefined,
      dashboardError: board.provider.loadError$.value,
      onOpenArtifact: binding.onOpenArtifact,
      onRetryArtifacts: binding.onRetryArtifacts,
      onViewAll: binding.onViewAll,
    },
  };
}
