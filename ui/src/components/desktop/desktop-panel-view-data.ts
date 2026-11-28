import type { EnvironmentSummary, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { DockLayout } from "../dock-layout.ts";
import type { DesktopPanelControls, DesktopPanelInputs } from "./desktop-panel-inputs.ts";
import type { DesktopPanelState, DesktopSizingMode } from "./desktop-panel-state.ts";
import type { DesktopSessionOwner } from "./desktop-session-owner.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";
import type { DesktopHostSetup } from "./host-desktop-setup.ts";

type DesktopViewFacts = {
  host: DesktopPanelInputs;
  surfaceRef: (target: HTMLElement | undefined) => void;
  environments: EnvironmentSummary[];
  currentId: string | null;
  phase: DesktopPanelState;
  loading: boolean;
  automaticSource: boolean;
  hostSetup: DesktopHostSetup | null;
  controlling: boolean;
  errorText: string | null;
  noticeText: string | null;
  disconnectedReason: string | null;
  connectionTransition: "connecting" | "taking-control" | "switching-to-viewing";
  connectionFailure: "error" | "lost" | "closed" | null;
  controlTakeoverRecoveryUsed: boolean;
  desktopApps: WorkerDesktopAppId[];
  sizingMode: DesktopSizingMode;
  canResize: boolean;
  username: string;
  ardAccount: boolean;
  controls: DesktopPanelControls;
  sessionSource: Pick<DesktopSessionOwner, "desktopAvailability" | "startupEnvironment">;
  dockLayout: DockLayout<"bottom" | "right">;
};
type DesktopViewActions = {
  onRefresh: () => void;
  onConnect: (environmentId: string) => void;
  onCredentialsSubmit: (event: SubmitEvent) => void;
  onBack: (() => void) | undefined;
  onRetry: () => void;
  onSizingChange: (mode: DesktopSizingMode) => void;
  onControlToggle: () => void;
  onTakeControl: () => void;
  onLaunch: (app: WorkerDesktopAppId) => void;
  onClose: () => void;
  onDocumentClose: () => void;
  focusTarget: () => {
    basePath: string;
    source: string | null;
    control: boolean;
    workspaceControls: boolean;
  };
  onDisconnect: () => void;
};
/** Pure presentation projection; every operation closes over the original live owner. */
export function projectDesktopPanelView(facts: DesktopViewFacts, actions: DesktopViewActions) {
  const {
    host,
    surfaceRef,
    environments,
    currentId,
    phase,
    loading,
    automaticSource,
    hostSetup,
    controlling,
    errorText,
    noticeText,
    disconnectedReason,
    connectionTransition,
    connectionFailure,
    controlTakeoverRecoveryUsed,
    desktopApps,
    sizingMode,
    canResize,
    username,
    ardAccount,
    controls,
    sessionSource,
    dockLayout,
  } = facts;
  const environment = environments.find((entry) => entry.id === currentId);
  const automaticPicker = automaticSource && host.embedded && host.sessionKey !== null;
  // Before a session's desktop is found, Retry checks the source; it is not a reconnect.
  const unresolvedSource = automaticPicker && !currentId && !hostSetup;
  const checkingSource = unresolvedSource && (phase === "picker" || phase === "inventory-error");
  return {
    documentMode: host.documentMode,
    embedded: host.embedded,
    surfaceRef,
    workspaceControls: host.workspaceControls,
    machine: currentId
      ? {
          name: environment?.label || currentId,
          host: desktopSourceForEnvironment({ id: currentId }).kind === "host",
        }
      : null,
    content: {
      state: checkingSource ? ("picker" as const) : phase,
      loading,
      automaticSource,
      hasTarget: host.sessionKey !== null || host.requestedSource !== null,
      errorText: checkingSource ? null : errorText,
      noticeText: unresolvedSource ? null : noticeText,
      takeoverText:
        controlTakeoverRecoveryUsed && (phase === "connecting" || phase === "connected")
          ? noticeText
          : null,
      transition: connectionTransition,
      availability: sessionSource.desktopAvailability,
      picker: {
        automatic: automaticPicker,
        // A presenter that names the desktop connects to it while it loads, until the
        // source is reported unavailable; Retry then checks the source again.
        knownTarget: host.requestedSource !== null && noticeText === null && errorText === null,
        notice: checkingSource ? (errorText ?? noticeText) : null,
        onDisconnect: actions.onDisconnect,
        environments,
        hostSetup,
        onRefresh:
          checkingSource && phase === "inventory-error" ? actions.onRetry : actions.onRefresh,
        onConnect: actions.onConnect,
      },
      credentials: {
        ardAccount,
        username,
        onSubmit: actions.onCredentialsSubmit,
        onBack: actions.onBack,
      },
      recovery: {
        kind: connectionFailure,
        reason: disconnectedReason,
        onRetry: actions.onRetry,
      },
    },
    controlling,
    desktopApps,
    launcher: controls.launcher,
    startup: sessionSource.startupEnvironment,
    sizing: {
      mode: sizingMode,
      canResize: canResize && controlling && phase === "connected",
      onChange: actions.onSizingChange,
    },
    mobileKeyboard: controls.mobileKeyboard,
    pictureInPicture: controls.pictureInPicture,
    audio: controls.audio,
    fullscreenMode: controls.fullscreenMode,
    dockLayout,
    onControlToggle: actions.onControlToggle,
    onTakeControl: actions.onTakeControl,
    onLaunch: actions.onLaunch,
    onClose: actions.onClose,
    onDocumentClose: actions.onDocumentClose,
    focusTarget: actions.focusTarget,
    onDisconnect: actions.onDisconnect,
  };
}
