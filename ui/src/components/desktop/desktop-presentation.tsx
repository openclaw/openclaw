import type { EnvironmentSummary, WorkerDesktopAppId } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { t } from "../../lib/reactive/i18n.ts";
import type { DockLayoutController } from "../dock-layout-controller.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import type { DesktopFullscreenController } from "../fullscreen-controller.ts";
import { FullscreenButton } from "../fullscreen-solid.tsx";
import { DesktopAudioControl, DesktopAudioNotice } from "./desktop-audio-view.tsx";
import type { DesktopAudio } from "./desktop-audio.ts";
import { DesktopDocumentView } from "./desktop-document-view.tsx";
import { openDesktopFocus } from "./desktop-focus-window.ts";
import type { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import {
  DesktopPanelRecovery,
  DesktopCredentials,
  DesktopPicker,
  DesktopNotice,
  DesktopPanelView,
  type DesktopSizingOptions,
} from "./desktop-panel-view.tsx";
import type { DesktopPictureInPicture } from "./desktop-picture-in-picture.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

type DesktopPresentationOptions = {
  documentMode: boolean;
  embedded: boolean;
  workspaceControls: boolean;
  content: {
    state: DesktopPanelState;
    loading: boolean;
    automaticSource: boolean;
    hasTarget: boolean;
    errorText: string | null;
    noticeText: string | null;
    availability: Parameters<typeof DesktopNotice>[0]["availability"];
    picker: Omit<Parameters<typeof DesktopPicker>[0], "loading">;
    credentials: Parameters<typeof DesktopCredentials>[0];
    recovery: Omit<Parameters<typeof DesktopPanelRecovery>[0], "inventoryError">;
  };
  controlling: boolean;
  desktopApps: WorkerDesktopAppId[];
  launchingApp: WorkerDesktopAppId | null;
  startup: EnvironmentSummary | undefined;
  sizing: DesktopSizingOptions;
  mobileKeyboard: DesktopMobileKeyboard;
  pictureInPicture: DesktopPictureInPicture;
  audio: DesktopAudio;
  dockLayout: DockLayoutController<"bottom" | "right">;
  fullscreenMode: DesktopFullscreenController;
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

function PictureInPictureButton(props: {
  controller: DesktopPictureInPicture;
  connected: boolean;
  documentMode: boolean;
}) {
  const label = () =>
    t(
      props.controller.active
        ? "desktop.exitPictureInPicture"
        : props.controller.supported
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
      aria-pressed={props.controller.active ? "true" : "false"}
      aria-busy={props.controller.pending ? "true" : "false"}
      disabled={!props.controller.supported || !props.connected || props.controller.pending}
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
export function DesktopPresentation(props: { view: DesktopPresentationOptions }) {
  const content = {
    get state(): DesktopPanelState {
      return props.view.content.state === "picker" &&
        props.view.content.loading &&
        props.view.content.automaticSource &&
        props.view.content.hasTarget
        ? "connecting"
        : props.view.content.state;
    },
    notice(): JSX.Element {
      return (
        <>
          <DesktopNotice
            errorText={props.view.pictureInPicture.errorText ?? props.view.content.errorText}
            noticeText={props.view.content.noticeText}
            availability={props.view.content.availability}
          />
          <DesktopAudioNotice state={props.view.audio.state} />
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
    picker(): JSX.Element {
      return <DesktopPicker {...props.view.content.picker} loading={props.view.content.loading} />;
    },
    credentials(): JSX.Element {
      return <DesktopCredentials {...props.view.content.credentials} />;
    },
    recovery(): JSX.Element {
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
      state={props.view.audio.state}
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
          controlling={props.view.controlling}
          sizing={props.view.sizing}
          keyboardInputValue={props.view.mobileKeyboard.value}
          pictureInPictureControl={pictureInPictureControl()}
          audioControl={audioControl()}
          onControlToggle={props.view.onControlToggle}
          onKeyboardFocus={(event) => props.view.mobileKeyboard.focus(event)}
          onKeyboardEvent={(event) => props.view.mobileKeyboard.handleKeyboardEvent(event)}
          onKeyboardInput={(event) => props.view.mobileKeyboard.handleInput(event)}
          onClose={props.view.onDocumentClose}
        />
      ) : (
        <DesktopPanelView
          embedded={props.view.embedded}
          workspaceControls={props.view.workspaceControls}
          dock={props.view.dockLayout.dock}
          height={props.view.dockLayout.height}
          width={props.view.dockLayout.width}
          fullscreen={props.view.fullscreenMode.active}
          renderResizer={() => (
            <DockResizer
              controller={props.view.dockLayout}
              classPrefix="bp"
              label={t("desktop.resize")}
            />
          )}
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
          connection={{
            get controlling() {
              return props.view.controlling;
            },
            get desktopApps() {
              return props.view.desktopApps;
            },
            get launchingApp() {
              return props.view.launchingApp;
            },
            get showApps() {
              const target = props.view.focusTarget();
              return (
                target.source !== null &&
                desktopSourceForEnvironment({ id: target.source }).kind === "environment"
              );
            },
            get sizing() {
              return props.view.sizing;
            },
            get pictureInPictureControl() {
              return pictureInPictureControl();
            },
            get audioControl() {
              return audioControl();
            },
            onLaunch: (app) => props.view.onLaunch(app),
            onTakeControl: () => props.view.onTakeControl(),
            onControlToggle: () => props.view.onControlToggle(),
            onDisconnect: () => props.view.onDisconnect(),
          }}
        />
      )}
    </>
  );
}
