import type { WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { DockLayoutController } from "../dock-layout-controller.ts";
import { renderDesktopDocumentView } from "./desktop-document-view.ts";
import type { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelFullscreenController } from "./desktop-panel-fullscreen-controller.ts";
import { renderDesktopPanelView, type DesktopSizingOptions } from "./desktop-panel-view.ts";

type DesktopPresentation = {
  documentMode: boolean;
  embedded: boolean;
  workspaceControls: boolean;
  content: Parameters<typeof renderDesktopPanelView>[0]["content"];
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  environmentSelected: boolean;
  launchingApp: WorkerDesktopAppId | null;
  showApps: boolean;
  sizing: DesktopSizingOptions;
  mobileKeyboard: DesktopMobileKeyboard;
  pictureInPictureControl: TemplateResult;
  dockLayout: DockLayoutController<"bottom" | "right">;
  fullscreenMode: DesktopPanelFullscreenController;
  onControlToggle: () => void;
  onTakeControl: () => void;
  onLaunch: (app: WorkerDesktopAppId) => void;
  onClose: () => void;
  onDocumentClose: () => void;
  onOpenWindow: () => void;
  onDisconnect: () => void;
};

/** Compose the existing document and dock views without owning connection state. */
export function renderDesktopPresentation(view: DesktopPresentation) {
  if (view.documentMode) {
    return renderDesktopDocumentView({
      ...view.content,
      controlling: view.controlling,
      sizing: view.sizing,
      keyboardInputValue: view.mobileKeyboard.value,
      pictureInPictureControl: view.pictureInPictureControl,
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
    onOpenWindow: view.onOpenWindow,
    onClose: view.onClose,
    content: view.content,
    connection: {
      controlling: view.controlling,
      desktopApps: view.desktopApps,
      environmentSelected: view.environmentSelected,
      launchingApp: view.launchingApp,
      showApps: view.showApps,
      sizing: view.sizing,
      pictureInPictureControl: view.pictureInPictureControl,
      onLaunch: view.onLaunch,
      onTakeControl: view.onTakeControl,
      onDisconnect: view.onDisconnect,
    },
  });
}
