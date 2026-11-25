import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import type { ControlUiFocusBuildTarget } from "@openclaw/session-url-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import type { DesktopFullscreen } from "../desktop-fullscreen.ts";
import type { DesktopAppLauncher } from "./desktop-app-launcher.ts";
import type { DesktopAudio } from "./desktop-audio.ts";
import type { DesktopClient } from "./desktop-client.ts";
import type { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPictureInPicture } from "./desktop-picture-in-picture.ts";
import type { HostDesktopRuntimeConfig } from "./host-desktop-setup.ts";

/** Supplied by the native shell, independently of the pane's width. */
export type DesktopPanelPresentationContext = {
  platform: "desktop" | "mobile";
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** The shell's current native focus URL, with its session/source and control mode. */
  openWindowHref?: string;
};

export type DesktopPanelInputs = {
  client: GatewayBrowserClient | null;
  sessions: Pick<SessionCapability, "describe"> | undefined;
  available: boolean;
  suppressed: boolean;
  documentMode: boolean;
  presentation?: DesktopPanelPresentationContext | null;
  requestedSource: string | null;
  sessionKey: string | null;
  documentControl: boolean;
  basePath: string;
  /** Host-owned inventory; null preserves the standalone/session inventory owner. */
  suppliedEnvironments: readonly EnvironmentSummary[] | null;
  workspaceControls: boolean;
  embedded: boolean;
  presented: boolean;
  refreshOnPresentation: boolean;
  onDocumentClose: (() => void) | null;
  onFocusTargetChange:
    | ((target: Extract<ControlUiFocusBuildTarget, { kind: "desktop" }>) => void)
    | null;
  /** Host-owned config authority for Host Desktop setup; null hides the enable action. */
  runtimeConfig: HostDesktopRuntimeConfig | null;
  /** Browser tests replace the transport without opening a real RFB socket. */
  desktopClientFactory: () => Pick<DesktopClient, "connect">;
};

export type DesktopPanelControls = {
  audio: DesktopAudio;
  mobileKeyboard: DesktopMobileKeyboard;
  pictureInPicture: DesktopPictureInPicture;
  launcher: DesktopAppLauncher;
  fullscreenMode: DesktopFullscreen;
};
