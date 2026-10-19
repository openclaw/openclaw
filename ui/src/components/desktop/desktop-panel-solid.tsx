import type { JSX as SolidJSX } from "@solidjs/web";
import { merge, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { nativeDockPanelCss as dockStyles } from "../dock-panel-styles.ts";
import { FullscreenButton } from "../fullscreen-solid.tsx";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import { DesktopAudioControl, DesktopAudioNotice } from "./desktop-audio-view.tsx";
import { createDesktopAudio } from "./desktop-audio.ts";
import { desktopCanvas, DesktopClient } from "./desktop-client.ts";
import { DesktopDocumentView } from "./desktop-document-view.tsx";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelInputs } from "./desktop-panel-inputs.ts";
import { createDesktopPanel, type DesktopPanelOwner } from "./desktop-panel-owner.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import {
  DesktopPanelRecovery,
  DesktopCredentials,
  DesktopPicker,
  DesktopNotice,
  DesktopPanelView,
} from "./desktop-panel-view.tsx";
import {
  createDesktopPictureInPicture,
  type DesktopPictureInPicture,
} from "./desktop-picture-in-picture.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";
import desktopStyles from "./desktop-panel.css?inline";

type Methods = { handleToggleRequest(event: Event): void };
type DesktopPanelElement = SolidBridgeElement<DesktopPanelInputs, Methods>;
// Preserve the native host's source and dock intent through context remounts.
const owners = new WeakMap<HTMLElement, DesktopPanelOwner>();
const ownerFor = (host: DesktopPanelElement) => {
  let owner = owners.get(host);
  if (!owner) {
    owner = createDesktopPanel(host, onSettled);
    owners.set(host, owner);
  }
  return owner;
};
defineSolidBridge<DesktopPanelInputs, Methods>(
  "openclaw-desktop-panel",
  (inputs, host) => {
    const retained = owners.has(host);
    const panel = ownerFor(host);
    const fullscreen = createDesktopFullscreen(host.ownerDocument, panel.notify);
    panel.attach(
      {
        audio: createDesktopAudio(host, panel.audioTarget),
        mobileKeyboard: createDesktopMobileKeyboard(panel.keyboardTarget),
        pictureInPicture: createDesktopPictureInPicture(host, () => {
          const target = panel.launchTarget();
          return host.available && target.state === "connected" && target.presented
            ? desktopCanvas(panel.surface())
            : null;
        }),
        launcher: createDesktopAppLauncher(panel.launchTarget),
        fullscreenMode: fullscreen,
      },
      retained,
    );
    const state = projectOwner(panel, (owner) => owner);
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
    propertyChanged: (host) => owners.get(host)?.inputsChanged(),
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

function PictureInPictureButton(props: {
  controller: DesktopPictureInPicture;
  connected: boolean;
  documentMode: boolean;
}) {
  const label = () =>
    t(
      props.controller.feedback().active
        ? "desktop.exitPictureInPicture"
        : props.controller.supported()
          ? "desktop.enterPictureInPicture"
          : "desktop.pictureInPictureUnavailable",
    );
  return (
    <button
      class={[
        props.documentMode ? "desktop-touch-action" : "desktop-toolbar-action",
        "desktop-picture-in-picture-button",
      ]}
      type="button"
      title={label()}
      aria-label={label()}
      aria-pressed={props.controller.feedback().active ? "true" : "false"}
      aria-busy={props.controller.feedback().pending ? "true" : "false"}
      disabled={
        !props.controller.supported() || !props.connected || props.controller.feedback().pending
      }
      onClick={() => void props.controller.toggle()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <rect x="12" y="11" width="7" height="7" rx="1" />
      </svg>
    </button>
  );
}

/** Compose the document and dock views without owning connection state. */
function DesktopPresentation(props: { view: DesktopPanelOwner["view"] }) {
  const content = {
    get state(): DesktopPanelState {
      return props.view.content.state === "picker" &&
        props.view.content.loading &&
        props.view.content.automaticSource &&
        props.view.content.hasTarget
        ? "connecting"
        : props.view.content.state;
    },
    notice(): SolidJSX.Element {
      return (
        <>
          <DesktopNotice
            errorText={
              props.view.pictureInPicture.feedback().errorText ??
              props.view.fullscreenMode.errorText() ??
              props.view.content.errorText
            }
            noticeText={props.view.content.noticeText}
            availability={props.view.content.availability}
          />
          <DesktopAudioNotice state={props.view.audio.state()} />
          {props.view.startup && (
            <DesktopNotice
              errorText={null}
              noticeText={t(
                props.view.startup.worker?.state === "bootstrapping"
                  ? "desktop.preparing"
                  : "desktop.starting",
              )}
            />
          )}
        </>
      );
    },
    picker(): SolidJSX.Element {
      return <DesktopPicker {...props.view.content.picker} loading={props.view.content.loading} />;
    },
    credentials(): SolidJSX.Element {
      return <DesktopCredentials {...props.view.content.credentials} />;
    },
    recovery(): SolidJSX.Element {
      return (
        <DesktopPanelRecovery
          {...props.view.content.recovery}
          inventoryError={props.view.content.state === "inventory-error"}
        />
      );
    },
  };
  const pictureInPictureControl = () => (
    <PictureInPictureButton
      controller={props.view.pictureInPicture}
      connected={props.view.content.state === "connected"}
      documentMode={props.view.documentMode}
    />
  );
  const audioControl = () => (
    <DesktopAudioControl
      state={props.view.audio.state()}
      connected={props.view.content.state === "connected"}
      documentMode={props.view.documentMode}
      onToggle={() => props.view.audio.toggle()}
    />
  );
  return (
    <>
      {props.view.documentMode ? (
        <DesktopDocumentView
          {...content}
          surfaceRef={props.view.surfaceRef}
          controlling={props.view.controlling}
          sizing={props.view.sizing}
          keyboard={props.view.mobileKeyboard}
          pictureInPictureControl={pictureInPictureControl()}
          audioControl={audioControl()}
          onControlToggle={props.view.onControlToggle}
          onClose={props.view.onDocumentClose}
        />
      ) : (
        <DesktopPanelView
          embedded={props.view.embedded}
          workspaceControls={props.view.workspaceControls}
          dock={props.view.dockLayout.dock}
          height={props.view.dockLayout.height}
          width={props.view.dockLayout.width}
          fullscreen={props.view.fullscreenMode.active()}
          sectionRef={props.view.fullscreenMode.sectionRef}
          renderResizer={() =>
            !props.view.fullscreenMode.active() && (
              <DockResizer
                controller={props.view.dockLayout}
                classPrefix="bp"
                label={t("desktop.resize")}
              />
            )
          }
          renderFullscreenControl={() => (
            <FullscreenButton controller={props.view.fullscreenMode} />
          )}
          onDock={(dock) => props.view.dockLayout.setDock(dock)}
          onOpenWindow={() => {
            const target = props.view.focusTarget();
            // Read the current target at click time; workspace pop-outs never take input.
            openDesktopFocus(
              target.basePath,
              target.source,
              target.workspaceControls ? false : target.control,
            );
          }}
          onClose={props.view.onClose}
          content={content}
          connection={merge(() => props.view, {
            get showApps() {
              const target = props.view.focusTarget();
              return (
                target.source !== null &&
                desktopSourceForEnvironment({ id: target.source }).kind === "environment"
              );
            },
            get pictureInPictureControl() {
              return pictureInPictureControl();
            },
            get audioControl() {
              return audioControl();
            },
          })}
        />
      )}
    </>
  );
}
