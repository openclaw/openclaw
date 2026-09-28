import type { EnvironmentSummary, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DockLayoutController } from "../dock-layout-controller.ts";
import type { FullscreenController } from "../fullscreen-controller.ts";
import { renderDesktopDocumentView } from "./desktop-document-view.ts";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import type { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import { renderDesktopPanelRecovery, type DesktopPanelState } from "./desktop-panel-state.ts";
import {
  renderDesktopCredentials,
  renderDesktopPicker,
  renderDesktopNotice,
  renderDesktopPanelView,
  type DesktopSizingOptions,
} from "./desktop-panel-view.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

export const desktopFullscreenOptions = {
  buttonClass: "bp-icon desktop-fullscreen-button",
  buttonSelector: ".desktop-fullscreen-button",
  iconClass: "desktop-fullscreen-icon",
  enterLabel: () => t("desktop.enterFullscreen"),
  exitLabel: () => t("desktop.exitFullscreen"),
  unavailableLabel: () => t("desktop.fullscreenUnavailable"),
  errorMessage: (error: unknown) =>
    t("desktop.errors.fullscreenFailed", { error: formatUiError(error) }),
};

type DesktopPresentation = {
  documentMode: boolean;
  embedded: boolean;
  workspaceControls: boolean;
  content: {
    state: DesktopPanelState;
    loading: boolean;
    automaticSource: boolean;
    hasTarget: boolean;
    notice: Parameters<typeof renderDesktopPanelView>[0]["content"]["notice"];
    picker: Omit<Parameters<typeof renderDesktopPicker>[0], "loading">;
    credentials: Parameters<typeof renderDesktopCredentials>[0];
    recovery: Omit<Parameters<typeof renderDesktopPanelRecovery>[0], "inventoryError">;
  };
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  launchingApp: WorkerDesktopAppId | null;
  startup: EnvironmentSummary | undefined;
  sizing: DesktopSizingOptions;
  mobileKeyboard: DesktopMobileKeyboard;
  pictureInPictureControl: TemplateResult;
  audioControl?: TemplateResult;
  dockLayout: DockLayoutController<"bottom" | "right">;
  fullscreenMode: FullscreenController;
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

/** Compose the existing document and dock views without owning connection state. */
export function renderDesktopPresentation(view: DesktopPresentation) {
  const content: Parameters<typeof renderDesktopPanelView>[0]["content"] = {
    // Source lookup and RFB authentication share the same loading stage.
    state:
      view.content.state === "picker" &&
      view.content.loading &&
      view.content.automaticSource &&
      view.content.hasTarget
        ? "connecting"
        : view.content.state,
    notice: view.startup
      ? html`${view.content.notice}${renderDesktopNotice(null, t(view.startup.worker?.state === "bootstrapping" ? "desktop.preparing" : "desktop.starting"))}`
      : view.content.notice,
    picker: renderDesktopPicker({ ...view.content.picker, loading: view.content.loading }),
    credentials: renderDesktopCredentials(view.content.credentials),
    recovery: renderDesktopPanelRecovery({
      ...view.content.recovery,
      inventoryError: view.content.state === "inventory-error",
    }),
  };
  const focus = view.focusTarget();
  if (view.documentMode) {
    return renderDesktopDocumentView({
      ...content,
      controlling: view.controlling,
      sizing: view.sizing,
      keyboardInputValue: view.mobileKeyboard.value,
      pictureInPictureControl: view.pictureInPictureControl,
      audioControl: view.audioControl,
      onControlToggle: view.onControlToggle,
      onKeyboardFocus: (event) => view.mobileKeyboard.focus(event),
      onKeyboardEvent: (event) => view.mobileKeyboard.handleKeyboardEvent(event),
      onKeyboardInput: (event) => view.mobileKeyboard.handleInput(event),
      onClose: view.onDocumentClose,
    });
  }
  return renderDesktopPanelView({
    embedded: view.embedded,
    workspaceControls: view.workspaceControls,
    dock: view.dockLayout.dock,
    height: view.dockLayout.height,
    width: view.dockLayout.width,
    fullscreen: view.fullscreenMode.active,
    renderResizer: () => view.dockLayout.renderResizer("bp", t("desktop.resize")),
    renderFullscreenControl: () => view.fullscreenMode.renderButton(),
    onDock: (dock) => view.dockLayout.setDock(dock),
    onOpenWindow: () => {
      const target = view.focusTarget();
      // Read the current target at click time; workspace pop-outs never take input.
      openDesktopFocus(
        target.basePath,
        target.source,
        target.workspaceControls ? false : target.control,
      );
    },
    onClose: view.onClose,
    content,
    connection: {
      controlling: view.controlling,
      desktopApps: view.desktopApps,
      environmentSelected: focus.source !== null,
      launchingApp: view.launchingApp,
      showApps:
        focus.source !== null &&
        desktopSourceForEnvironment({ id: focus.source }).kind === "environment",
      sizing: view.sizing,
      pictureInPictureControl: view.pictureInPictureControl,
      audioControl: view.audioControl,
      onLaunch: view.onLaunch,
      onTakeControl: view.onTakeControl,
      onControlToggle: view.onControlToggle,
      onDisconnect: view.onDisconnect,
    },
  });
}
