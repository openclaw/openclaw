import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { detailsOutputsIcons } from "./chat-details-output-icons.tsx";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
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
  boardReady: boolean,
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
  let releaseBoard: (() => void) | undefined;
  const { promise: dashboardRead, resolve: completeDashboard } = Promise.withResolvers<void>();
  const settleDashboard = () => {
    releaseBoard?.();
    releaseBoard = undefined;
    completeDashboard();
  };
  if (boardReady) {
    const settleIfReady = () => {
      if (provider.hasLoadedSnapshot || provider.loadError$.value) {
        settleDashboard();
      }
    };
    const releaseSnapshot = provider.snapshot$.subscribe(settleIfReady);
    const releaseError = provider.loadError$.subscribe(settleIfReady);
    releaseBoard = () => {
      releaseSnapshot();
      releaseError();
    };
    settleIfReady();
  }
  const releaseArtifacts = () => {
    release?.();
    release = undefined;
  };
  const stop = () => {
    releaseArtifacts();
    // Retired presentation reads cannot hold a Solid loading boundary open.
    settleDashboard();
  };
  return {
    state,
    workspace,
    provider,
    boardReady,
    dashboardRead,
    client,
    connected,
    sessionId,
    scope,
    stop,
    retain: () => {
      releaseArtifacts();
      if (!current()) {
        return undefined;
      }
      const releaseDemand = retainSessionWorkspaceArtifacts(state, "assistant");
      release = releaseDemand;
      return () => {
        if (release === releaseDemand) {
          releaseArtifacts();
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
): Pick<ChatDetailsProps, "outputs" | "retainOutputs"> {
  const artifacts = workspace.assistantArtifacts;
  return {
    retainOutputs: binding.retain,
    outputs: {
      ...detailsOutputsIcons,
      artifacts: artifacts?.resolved ? artifacts.items : null,
      artifactRead: artifacts,
      artifactsError: artifacts?.error ?? null,
      dashboard: !board.available
        ? null
        : binding.boardReady && board.provider.hasLoadedSnapshot
          ? board.hasBoard
            ? {
                title:
                  board.snapshot.tabs.find((tab) => tab.tabId === board.activeTabId)?.title ??
                  t("outputs.dashboard"),
                onOpen: binding.onOpenDashboard,
              }
            : null
          : undefined,
      dashboardRead: binding.dashboardRead,
      dashboardError: board.provider.loadError$.value,
      onOpenArtifact: binding.onOpenArtifact,
      onRetryArtifacts: binding.onRetryArtifacts,
      onViewAll: binding.onViewAll,
    },
  };
}
