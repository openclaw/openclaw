import { createEffect, createSignal, onSettled } from "solid-js";
import { i18n } from "../../i18n/lib/translate.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import { createDesktopAudio } from "./desktop-audio.ts";
import { DesktopClient } from "./desktop-client.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelInputs } from "./desktop-panel-inputs.ts";
import { createDesktopPanel, type DesktopPanelOwner } from "./desktop-panel-owner.ts";
import { createDesktopPictureInPicture } from "./desktop-picture-in-picture.ts";
import { DesktopPresentation } from "./desktop-presentation.tsx";
import dockStyles from "../dock-panel-solid.css?inline";
import desktopStyles from "./desktop-panel.css?inline";

type Methods = { handleToggleRequest(event: Event): void };
type DesktopPanelElement = SolidBridgeElement<DesktopPanelInputs, Methods>;
// Preserve the native host's source and dock intent through context remounts.
const owners = new WeakMap<HTMLElement, DesktopPanelOwner>();
const ownerFor = (host: DesktopPanelElement) => {
  let owner = owners.get(host);
  if (!owner) {
    owner = createDesktopPanel(host);
    owners.set(host, owner);
  }
  return owner;
};
defineSolidBridge<DesktopPanelInputs, Methods>(
  "openclaw-desktop-panel",
  (inputs, host) => {
    const retained = owners.has(host);
    const panel = ownerFor(host);
    const fullscreen = createDesktopFullscreen(host.ownerDocument);
    const detachPanel = panel.attach({
      audio: createDesktopAudio(host, panel.audioTarget),
      mobileKeyboard: createDesktopMobileKeyboard(panel.keyboardTarget),
      pictureInPicture: createDesktopPictureInPicture(host, () => {
        const target = panel.launchTarget();
        return host.available && target.state === "connected" && target.presented
          ? (panel.surface()?.querySelector<HTMLCanvasElement>("canvas") ?? null)
          : null;
      }),
      launcher: createDesktopAppLauncher(panel.launchTarget),
      fullscreenMode: fullscreen,
    });
    const state = projectOwner(panel, (owner) => owner);
    const [mounted, setMounted] = createSignal(false);
    // Prop changes reconcile synchronous transport authority, not copied rendering state.
    createEffect(
      () =>
        mounted()
          ? { ...inputs, revision: state.revision(), fullscreen: fullscreen.active() }
          : undefined,
      (next, previous) => {
        if (next) {
          panel.reconcile(next, previous);
        }
      },
    );
    createEffect(
      () => !inputs.embedded,
      (standalone) =>
        standalone
          ? listen(window, DESKTOP_PANEL_TOGGLE_EVENT, panel.handleToggleRequest)
          : undefined,
    );
    createEffect(
      () => (inputs.available && inputs.suppliedEnvironments === null ? inputs.client : null),
      (client) => (client ? panel.sessionSource.subscribe(client) : undefined),
    );
    onSettled(() => {
      const open = panel.dockLayout.open;
      panel.dockLayout.connect();
      if (retained) {
        panel.dockLayout.setOpen(open, false);
      }
      setMounted(true);
      const stopLocale = i18n.subscribe(panel.notify);
      return () => {
        stopLocale();
        state.dispose();
        detachPanel();
        panel.dockLayout.dispose();
      };
    });
    return (
      <>
        <style>{`${dockStyles}\n${desktopStyles}`}</style>
        {inputs.available &&
          (inputs.documentMode || inputs.embedded || state.read().dockLayout.open) && (
            <DesktopPresentation view={state.read().view} />
          )}
      </>
    );
  },
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
    methods: { handleToggleRequest: (host, event) => ownerFor(host).handleToggleRequest(event) },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-desktop-panel": DesktopPanelElement;
  }
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-desktop-panel": HTMLAttributes<DesktopPanelElement> & {
        [Key in keyof DesktopPanelInputs as `prop:${Key}`]?: DesktopPanelInputs[Key];
      } & { embedded?: boolean };
    }
  }
}
