import type { EnvironmentSummary, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { DockLayoutController } from "../dock-layout-controller.ts";
import { renderDesktopDocumentView } from "./desktop-document-view.ts";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import type { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelFullscreenController } from "./desktop-panel-fullscreen-controller.ts";
import {
  renderDesktopNotice,
  renderDesktopPanelView,
  type DesktopSizingOptions,
} from "./desktop-panel-view.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

type DesktopPresentation = {
  documentMode: boolean;
  embedded: boolean;
  workspaceControls: boolean;
  content: Parameters<typeof renderDesktopPanelView>[0]["content"];
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  launchingApp: WorkerDesktopAppId | null;
  startup: EnvironmentSummary | undefined;
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
  const content = view.startup
    ? {
        ...view.content,
        notice: html`${view.content.notice}${renderDesktopNotice(null, t(view.startup.worker?.state === "bootstrapping" ? "desktop.preparing" : "desktop.starting"))}`,
      }
    : view.content;
  const focus = view.focusTarget();
  if (view.documentMode) {
    return renderDesktopDocumentView({
      ...content,
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
      onLaunch: view.onLaunch,
      onTakeControl: view.onTakeControl,
      onControlToggle: view.onControlToggle,
      onDisconnect: view.onDisconnect,
    },
  });
}
