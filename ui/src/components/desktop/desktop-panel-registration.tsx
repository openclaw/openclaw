import { definePanelBridge } from "../solid-panel-bridge.tsx";
import { DesktopClient } from "./desktop-client.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import { DesktopPanelContent } from "./desktop-panel-solid.tsx";
import dockStyles from "../dock-panel-solid.css?inline";
import desktopStyles from "./desktop-panel.css?inline";

export type DesktopPanelInputs = Pick<
  DesktopPanelController,
  | "client"
  | "available"
  | "suppressed"
  | "documentMode"
  | "requestedSource"
  | "sessionKey"
  | "documentControl"
  | "basePath"
  | "suppliedEnvironments"
  | "workspaceControls"
  | "embedded"
  | "presented"
  | "refreshOnPresentation"
  | "onDocumentClose"
  | "onFocusTargetChange"
  | "desktopClientFactory"
> & { sessions: DesktopPanelController["sessions"] | undefined };

type DesktopPanelElement = HTMLElement &
  Pick<
    DesktopPanelController,
    | keyof DesktopPanelInputs
    | "handleToggleRequest"
    | "requestUpdate"
    | "renderRoot"
    | "hasUpdated"
    | "updateComplete"
  >;

export function defineDesktopPanelElement(
  createController: (element: HTMLElement) => DesktopPanelController,
  tag = "openclaw-desktop-panel",
) {
  return definePanelBridge<
    DesktopPanelInputs,
    DesktopPanelController,
    "handleToggleRequest" | "requestUpdate"
  >(
    tag,
    createController,
    (controller) => (
      <>
        <style>{`${dockStyles}\n${desktopStyles}`.replaceAll("openclaw-desktop-panel", tag)}</style>
        <DesktopPanelContent controller={controller} />
      </>
    ),
    {
      properties: {
        client: { default: null, attribute: false },
        sessions: { default: undefined, attribute: false },
        available: { default: false, type: Boolean },
        suppressed: { default: false, type: Boolean },
        documentMode: { default: false, type: Boolean, reflect: true },
        requestedSource: { default: null, attribute: false },
        sessionKey: { default: null, attribute: false },
        documentControl: { default: false, type: Boolean },
        basePath: { default: "", attribute: false },
        suppliedEnvironments: { default: null, attribute: false },
        workspaceControls: { default: false, type: Boolean },
        embedded: { default: false, type: Boolean, reflect: true },
        presented: { default: false, type: Boolean },
        refreshOnPresentation: { default: true, type: Boolean },
        onDocumentClose: { default: null, attribute: false },
        onFocusTargetChange: { default: null, attribute: false },
        desktopClientFactory: { default: () => new DesktopClient(), attribute: false },
      },
      methods: ["handleToggleRequest", "requestUpdate"],
      getters: ["renderRoot", "hasUpdated"],
    },
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-desktop-panel": DesktopPanelElement;
  }
}
