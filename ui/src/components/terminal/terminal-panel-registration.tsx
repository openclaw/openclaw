import { ContextNotFoundError } from "@solidjs/signals";
import { useApplication } from "../../lib/reactive/context.ts";
import { definePanelBridge } from "../solid-panel-bridge.tsx";
import { TerminalPanel } from "./terminal-panel-component.tsx";
import { CATALOG_TERMINAL_READY_TIMEOUT_MS, TerminalPanelController } from "./terminal-panel.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import dockStyles from "../dock-panel-solid.css?inline";
import tabStyles from "../panel-tab-strip-solid.css?inline";
import terminalStyles from "./terminal-panel.css?inline";

export type TerminalInputs = Pick<
  TerminalPanelController,
  | "client"
  | "agentId"
  | "sessionKey"
  | "available"
  | "suppressed"
  | "themeMode"
  | "basePath"
  | "fullscreen"
  | "embedded"
  | "onClose"
  | "tabsInHeader"
  | "page"
  | "routeTarget"
  | "createTerminalController"
  | "catalogReadyTimeoutMs"
>;

export function defineTerminalPanelElement(
  tag = "openclaw-terminal-panel",
  createController: (element: HTMLElement) => TerminalPanelController = (element) =>
    new TerminalPanelController(element),
) {
  return definePanelBridge<
    TerminalInputs,
    TerminalPanelController,
    | "activateTerminalHost"
    | "toggle"
    | "closeTerminalPanel"
    | "hideTerminalPanelForUnavailableSurface"
    | "restoreTerminalPanelOpenState"
    | "resetTerminalSessionPicker"
    | "findTerminalPanelViewport"
    | "selectHostedTab"
    | "closeHostedTab"
    | "handleToggleRequest"
    | "requestUpdate"
  >(
    tag,
    createController,
    (controller) => {
      try {
        controller.context = useApplication();
      } catch (error) {
        if (!(error instanceof ContextNotFoundError)) {
          throw error;
        }
      }
      const styles = `${dockStyles}\n${tabStyles}\n${terminalStyles}`.replaceAll(
        "openclaw-terminal-panel",
        tag,
      );
      return (
        <>
          <style>{styles}</style>
          <TerminalPanel controller={controller} />
        </>
      );
    },
    {
      properties: {
        client: { default: null, attribute: false },
        agentId: { default: null, attribute: false },
        sessionKey: { default: null, attribute: false },
        available: { default: false, type: Boolean },
        suppressed: { default: false, type: Boolean },
        themeMode: { default: "dark", attribute: false },
        basePath: { default: "", attribute: false },
        fullscreen: { default: false, type: Boolean, reflect: true },
        embedded: { default: false, type: Boolean, reflect: true },
        onClose: { default: undefined, attribute: false },
        tabsInHeader: { default: false, type: Boolean },
        page: { default: false, type: Boolean },
        routeTarget: { default: null, attribute: false },
        createTerminalController: { default: createIsolatedGhosttyTerminal, attribute: false },
        catalogReadyTimeoutMs: { default: CATALOG_TERMINAL_READY_TIMEOUT_MS, attribute: false },
      },
      methods: [
        "activateTerminalHost",
        "toggle",
        "closeTerminalPanel",
        "hideTerminalPanelForUnavailableSurface",
        "restoreTerminalPanelOpenState",
        "resetTerminalSessionPicker",
        "findTerminalPanelViewport",
        "selectHostedTab",
        "closeHostedTab",
        "handleToggleRequest",
        "requestUpdate",
      ],
      getters: [
        "renderRoot",
        "hasUpdated",
        "hostedTabs",
        "activeHostedTabId",
        "hostedActions",
        "terminalPanelOpen",
        "terminalPanelUploadController",
      ],
    },
  );
}

export const TerminalPanelHost = defineTerminalPanelElement();
