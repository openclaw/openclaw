import type {
  CommandPaletteElement,
  CommandPaletteTargetDetail,
} from "../components/command-palette-contract.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import type { ShellNewSessionHost } from "./app-shell-new-session.ts";
import type { ShellPanelHost } from "./app-shell-panels.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import type { OptionalCustomElement } from "./lazy-custom-element.ts";
import type { NativeHistoryState } from "./native-web-chrome.ts";

export interface ShellChromeHost extends ShellNewSessionHost, ShellPanelHost {
  readonly element: HTMLElement;
  readonly isConnected: boolean;
  readonly activeSessionKey: string;
  readonly updateComplete: Promise<boolean>;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly execApprovalElement: OptionalCustomElement;
  readonly commandPalette: CommandPaletteElement | undefined;
  readonly approvalOverlay: (HTMLElement & { show(): void; dialogOpen?: boolean }) | undefined;
  navDrawerOpen: boolean;
  desktopNavigationExpanded: boolean;
  navDrawerTrigger: HTMLElement | null;
  nativeHistoryState: NativeHistoryState;
  commandPaletteTarget: CommandPaletteTargetDetail | undefined;
  requestUpdate(): void;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  exitSettings(): void;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  chatNavigationOptions(
    face: BoardFace,
    options?: ApplicationNavigationOptions,
  ): ApplicationNavigationOptions | undefined;
}
