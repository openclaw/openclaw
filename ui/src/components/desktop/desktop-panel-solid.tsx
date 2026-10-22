import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, merge, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { nativeDockPanelCss as dockStyles } from "../dock-panel-styles.ts";
import { FullscreenButton } from "../fullscreen-solid.tsx";
import { StrokeIcon } from "../solid/stroke-icon.tsx";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import { DesktopAudioControl, DesktopAudioNotice } from "./desktop-audio-view.tsx";
import { createDesktopAudio } from "./desktop-audio.ts";
import { desktopCanvas, DesktopClient } from "./desktop-client.ts";
import { DesktopDocumentView } from "./desktop-document-view.tsx";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type {
  DesktopPanelInputs,
  DesktopPanelPresentationContext,
} from "./desktop-panel-inputs.ts";
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
            <DesktopPresentation view={state.read().view} presentation={inputs.presentation} />
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
      presentation: { default: null, attribute: false },
      requestedSource: { default: null, attribute: false },
      sessionKey: { default: null, attribute: false },
      documentControl: { default: false, type: Boolean },
      basePath: { default: "", attribute: false },
      suppliedEnvironments: { default: null, attribute: false },
      workspaceControls: { default: false, type: Boolean },
      embedded: { default: false, type: Boolean, reflect: true },
      presented: { default: false, type: Boolean },
      refreshOnPresentation: { default: true, type: Boolean },
      runtimeConfig: { default: null, attribute: false },
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
  showLabel?: boolean;
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
      <StrokeIcon>
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <rect x="12" y="11" width="7" height="7" rx="1" />
      </StrokeIcon>
      {props.showLabel && <span class="desktop-rail__action-label">{label()}</span>}
    </button>
  );
}

/** Compose the document and dock views without owning connection state. */
function DesktopPresentation(props: {
  view: DesktopPanelOwner["view"];
  presentation?: DesktopPanelPresentationContext | null;
}) {
  const platform = createMemo(() =>
    props.view.documentMode ? undefined : props.presentation?.platform,
  );
  const desktop = createMemo(() => platform() === "desktop");
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
            noticeText={
              desktop() && props.view.content.takeoverText ? null : props.view.content.noticeText
            }
            availability={props.view.content.availability}
          />
          <DesktopAudioNotice state={props.view.audio.state()} />
          {!desktop() && props.view.startup && (
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
      return (
        <DesktopPicker
          {...props.view.content.picker}
          loading={props.view.content.loading}
          presentation={platform()}
          openWindowHref={desktop() ? props.presentation?.openWindowHref : undefined}
          genuineEmpty={
            !props.view.content.loading &&
            !props.view.content.errorText &&
            !props.view.content.noticeText &&
            !props.view.content.hasTarget &&
            !props.view.startup &&
            props.view.content.availability?.state !== "locked" &&
            props.view.content.availability?.state !== "unknown"
          }
        />
      );
    },
    credentials(): SolidJSX.Element {
      return (
        <DesktopCredentials
          {...props.view.content.credentials}
          presentation={platform()}
          machineName={props.view.machine?.name}
        />
      );
    },
    recovery(): SolidJSX.Element {
      return (
        <DesktopPanelRecovery
          {...props.view.content.recovery}
          inventoryError={props.view.content.state === "inventory-error"}
          presentation={platform()}
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
  const openWindow = () => {
    const target = props.view.focusTarget();
    // Read the current target at click time; workspace pop-outs never take input.
    openDesktopFocus(
      target.basePath,
      target.source,
      target.workspaceControls ? false : target.control,
    );
  };
  // Stable options identity; getters consume current owner facts without remounting the viewer.
  const rail = {
    get platform(): "desktop" | "mobile" {
      return platform() ?? "desktop";
    },
    get machine() {
      return props.view.machine;
    },
    get fullscreen() {
      return props.view.fullscreenMode.active();
    },
    get fullscreenSupported() {
      return props.view.fullscreenMode.supported();
    },
    get expanded() {
      return props.presentation?.expanded ?? false;
    },
    get onToggleExpanded() {
      return props.presentation?.onToggleExpanded;
    },
    get onOpenWindow() {
      return props.view.workspaceControls ? openWindow : undefined;
    },
    get openWindowHref() {
      return props.presentation?.openWindowHref;
    },
    get takeoverText() {
      return props.view.content.takeoverText;
    },
    get failureKind() {
      return props.view.content.recovery.kind;
    },
    get pendingLabel() {
      if (props.view.startup) {
        return t(
          props.view.startup.worker?.state === "bootstrapping"
            ? "desktop.preparing"
            : "desktop.starting",
        );
      }
      const transition =
        props.view.content.state === "connecting" ? props.view.content.transition : "connecting";
      return t(
        transition === "taking-control"
          ? "desktop.takingControl"
          : transition === "switching-to-viewing"
            ? "desktop.switchingToViewing"
            : "desktop.connecting",
      );
    },
    get controlTransition() {
      return (
        props.view.content.state === "connecting" && props.view.content.transition !== "connecting"
      );
    },
    onFullscreen: (button: HTMLButtonElement) => void props.view.fullscreenMode.toggle(button),
    audioControl: () =>
      (!props.view.fullscreenMode.active() ||
        (props.view.audio.state() !== "unavailable" &&
          props.view.audio.state() !== "unsupported")) &&
      audioControl(),
    pictureInPictureControl: () =>
      (!props.view.fullscreenMode.active() || props.view.pictureInPicture.supported()) && (
        <PictureInPictureButton
          controller={props.view.pictureInPicture}
          connected={props.view.content.state === "connected"}
          documentMode={false}
          showLabel
        />
      ),
  };
  const connection = merge(() => props.view, {
    get rail() {
      return platform() ? rail : undefined;
    },
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
  });
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
          desktopPresentation={desktop()}
          mobilePresentation={platform() === "mobile"}
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
          onOpenWindow={openWindow}
          onClose={props.view.onClose}
          content={content}
          connection={connection}
        />
      )}
    </>
  );
}
