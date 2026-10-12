import { html, nothing } from "lit";
import type { RouteId } from "../app-routes.ts";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import type { DebugOverlayFrameHost } from "../pages/debug/debug-overlay-frame.ts";
import {
  renderCommandPaletteLoading,
  type CommandPaletteLoadingState,
} from "./app-shell-command-palette-loading.ts";
import type { ShellNewSessionHost } from "./app-shell-new-session.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
} from "./lazy-custom-element.ts";
import type { LazyRenderer } from "./lazy-renderer.ts";
import { normalizeChatSendShortcut } from "./settings.ts";

export interface ShellLazyOverlayHost extends DebugOverlayFrameHost, ShellNewSessionHost {
  readonly commandPaletteElement: OptionalCustomElement;
  readonly commandPaletteLoading: CommandPaletteLoadingState;
  readonly debugOverlayFrame: LazyRenderer<
    typeof import("../pages/debug/debug-overlay-frame.ts").renderPendingDebugOverlay
  >;
  closePendingPalette(): void;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  handleCommandPaletteSlashCommand(command: string): void;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  selectChatSession(sessionKey: string, agentId?: string | null): void;
}

/** Shell-level optional dialogs share lazy-load recovery, not route ownership. */
export function renderShellLazyOverlays(
  host: ShellLazyOverlayHost,
  desktopPanelAvailable: boolean,
  custodianPanelAvailable: boolean,
  nativeEmbed: boolean,
) {
  const lazyElementState = host.lazyCustomElements.visibleState;
  const uiSettings = host.context?.theme.settings;
  if (
    lazyElementState?.element === DEBUG_OVERLAY_ELEMENT &&
    !host.debugOverlayFrame.renderer &&
    !host.debugOverlayFrame.failed
  ) {
    host.debugOverlayFrame.load();
  }
  return html`
    ${
      host.commandPaletteLoading.active &&
      (!lazyElementState ||
        (lazyElementState.status === "loading" &&
          lazyElementState.element === host.commandPaletteElement))
        ? renderCommandPaletteLoading(host.commandPaletteLoading, () => host.closePendingPalette())
        : lazyElementState?.element === DEBUG_OVERLAY_ELEMENT
          ? (host.debugOverlayFrame.renderer?.(host, lazyElementState) ??
            (host.debugOverlayFrame.failed
              ? renderLazyElementModal(host.lazyCustomElements)
              : nothing))
          : renderLazyElementModal(host.lazyCustomElements)
    }
    ${
      isOptionalElementDefined(host.commandPaletteElement)
        ? html`<openclaw-command-palette
            .desktopAvailable=${desktopPanelAvailable}
            .custodianAvailable=${custodianPanelAvailable}
            .onNavigate=${(routeId: RouteId, options?: ApplicationNavigationOptions) =>
              host.navigate(routeId, options)}
            .onSelectSession=${(sessionKey: string) => host.selectChatSession(sessionKey)}
            .onSlashCommand=${(command: string) => host.handleCommandPaletteSlashCommand(command)}
          ></openclaw-command-palette>`
        : nothing
    }
    ${isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT) ? html`<openclaw-debug-overlay></openclaw-debug-overlay>` : nothing}
    ${
      !nativeEmbed && isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT)
        ? html`<openclaw-keyboard-shortcuts-dialog
            .sendShortcut=${normalizeChatSendShortcut(uiSettings?.chatSendShortcut)}
            .newSessionHost=${host}
          ></openclaw-keyboard-shortcuts-dialog>`
        : nothing
    }
  `;
}
