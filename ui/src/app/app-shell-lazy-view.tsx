import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import type { RouteId } from "../app-routes.ts";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import {
  debugOverlayTemplate,
  renderPendingDebugOverlay,
  type DebugOverlayFrameHost,
} from "../pages/debug/debug-overlay-frame.ts";
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
import { LitRouteHost } from "./lit-route-host.tsx";
import { normalizeChatSendShortcut } from "./settings.ts";

/** Unported elements receive properties explicitly until their own lanes land. */
export type ShellElementAttributes = SolidJSX.HTMLAttributes<HTMLElement> & {
  [property: `prop:${string}`]: unknown;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-command-palette": ShellElementAttributes;
      "openclaw-keyboard-shortcuts-dialog": ShellElementAttributes;
    }
  }
}

export interface ShellLazyOverlayHost extends DebugOverlayFrameHost, ShellNewSessionHost {
  readonly commandPaletteElement: OptionalCustomElement;
  readonly commandPaletteLoading: CommandPaletteLoadingState;
  closePendingPalette(): void;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  handleCommandPaletteSlashCommand(command: string): void;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  selectChatSession(sessionKey: string, agentId?: string | null): void;
}

/** Shell-level optional dialogs share lazy-load recovery, not route ownership. */
export function ShellLazyOverlays(props: {
  host: ShellLazyOverlayHost;
  revision: number;
  desktopPanelAvailable: boolean;
  custodianPanelAvailable: boolean;
  nativeEmbed: boolean;
}): SolidJSX.Element {
  const state = createMemo(() => {
    return {
      revision: props.revision,
      lazy: props.host.lazyCustomElements.visibleState,
      paletteLoading: props.host.commandPaletteLoading.active,
      paletteDefined: isOptionalElementDefined(props.host.commandPaletteElement),
      debugDefined: isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT),
      shortcutsDefined: isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT),
      sendShortcut: normalizeChatSendShortcut(props.host.context?.theme.settings.chatSendShortcut),
    };
  });
  const onClose = () => props.host.closePendingPalette();
  return (
    <>
      <LitRouteHost
        renderValue={() => {
          const current = state();
          return current.paletteLoading &&
            (!current.lazy ||
              (current.lazy.status === "loading" &&
                current.lazy.element === props.host.commandPaletteElement))
            ? renderCommandPaletteLoading(props.host.commandPaletteLoading, onClose)
            : current.lazy?.element === DEBUG_OVERLAY_ELEMENT
              ? renderPendingDebugOverlay(props.host, current.lazy)
              : renderLazyElementModal(props.host.lazyCustomElements);
        }}
      />
      <Show when={state().paletteDefined}>
        <openclaw-command-palette
          prop:desktopAvailable={props.desktopPanelAvailable}
          prop:custodianAvailable={props.custodianPanelAvailable}
          prop:onNavigate={(routeId: RouteId, options?: ApplicationNavigationOptions) =>
            props.host.navigate(routeId, options)
          }
          prop:onSelectSession={(sessionKey: string) => props.host.selectChatSession(sessionKey)}
          prop:onSlashCommand={(command: string) =>
            props.host.handleCommandPaletteSlashCommand(command)
          }
        />
      </Show>
      <Show when={state().debugDefined}>
        <LitRouteHost renderValue={() => debugOverlayTemplate} />
      </Show>
      <Show when={!props.nativeEmbed && state().shortcutsDefined}>
        <openclaw-keyboard-shortcuts-dialog
          prop:sendShortcut={state().sendShortcut}
          prop:newSessionHost={props.host}
        />
      </Show>
    </>
  );
}
