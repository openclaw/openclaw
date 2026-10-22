import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import type { RouteId } from "../app-routes.ts";
import type { CommandPaletteElement } from "../components/command-palette-contract.ts";
import { LazyElementModal } from "../components/solid/lazy-view-error.tsx";
import type { KeyboardShortcutsDialogElement } from "../lib/keyboard-shortcut-contract.ts";
import type { DebugOverlayFrameHost } from "../pages/debug/debug-overlay-frame.ts";
import type { DebugOverlayElement } from "../pages/debug/debug-overlay-state.ts";
import { CommandPaletteLoading } from "./app-shell-command-palette-loading-view.tsx";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
import type { ShellNavigationCapability } from "./app-shell-navigation.ts";
import type { ShellNewSessionHost } from "./app-shell-new-session.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequests,
  type OptionalCustomElement,
  DEBUG_OVERLAY_ELEMENT,
  KEYBOARD_SHORTCUTS_ELEMENT,
} from "./lazy-custom-element.ts";
import { normalizeChatSendShortcut } from "./settings.ts";

const PendingDebugOverlay = lazy(() => import("../pages/debug/debug-overlay-frame.ts"), {
  export: "renderPendingDebugOverlay",
});

/** Unported elements receive properties explicitly until their own lanes land. */
export type ShellElementAttributes<T extends HTMLElement = HTMLElement> =
  SolidJSX.HTMLAttributes<T> & {
    [property: `prop:${string}`]: unknown;
  };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-command-palette": ShellElementAttributes<CommandPaletteElement>;
      "openclaw-debug-overlay": ShellElementAttributes<DebugOverlayElement>;
      "openclaw-keyboard-shortcuts-dialog": ShellElementAttributes<KeyboardShortcutsDialogElement>;
    }
  }
}

export interface ShellOwnedElements {
  commandPalette?: CommandPaletteElement;
  approvalOverlay?: HTMLElement & { show(): void; dialogOpen?: boolean };
  debugOverlay?: DebugOverlayElement;
  pendingDebugOverlayFrame?: HTMLElement;
  keyboardShortcuts?: KeyboardShortcutsDialogElement;
  assistantPanel?: HTMLElement;
  browserPanel?: HTMLElement;
  desktopPanel?: HTMLElement;
  linkReaderPanel?: HTMLElement;
}

export interface ShellLazyOverlayHost extends DebugOverlayFrameHost, ShellNewSessionHost {
  readonly shellNavigation: ShellNavigationCapability;
  readonly elements: ShellOwnedElements;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly commandPaletteLoading: CommandPaletteLoadingState;
  closePendingPalette(): void;
  readonly lazyCustomElements: LazyCustomElementRequests;
  handleCommandPaletteSlashCommand(command: string): void;
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
    void props.revision;
    const lazyState = props.host.lazyCustomElements.visibleState;
    return {
      lazy: lazyState,
      paletteLoading:
        props.host.commandPaletteLoading.active() &&
        (!lazyState ||
          (lazyState.status === "loading" &&
            lazyState.element === props.host.commandPaletteElement)),
      pendingDebug: lazyState?.element === DEBUG_OVERLAY_ELEMENT ? lazyState : undefined,
      paletteDefined: isOptionalElementDefined(props.host.commandPaletteElement),
      debugDefined: isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT),
      debugMode: props.host.pendingDebugOverlayMode,
      shortcutsDefined: isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT),
      sendShortcut: normalizeChatSendShortcut(props.host.context?.theme.settings.chatSendShortcut),
    };
  });
  const PendingElementModal = () => (
    <LazyElementModal
      state={state().lazy}
      onRetry={() => props.host.lazyCustomElements.retry()}
      onClose={() => props.host.lazyCustomElements.close()}
    />
  );
  return (
    <>
      <Show
        when={state().paletteLoading}
        fallback={
          <Show when={state().pendingDebug} fallback={<PendingElementModal />}>
            {(pending) => (
              <Errored fallback={<PendingElementModal />}>
                <Loading>
                  <PendingDebugOverlay
                    host={props.host}
                    state={pending()}
                    mode={state().debugMode}
                  />
                </Loading>
              </Errored>
            )}
          </Show>
        }
      >
        <CommandPaletteLoading
          state={props.host.commandPaletteLoading}
          onClose={() => props.host.closePendingPalette()}
        />
      </Show>
      <Show when={state().paletteDefined}>
        <openclaw-command-palette
          ref={(element) => (props.host.elements.commandPalette = element)}
          prop:desktopAvailable={props.desktopPanelAvailable}
          prop:custodianAvailable={props.custodianPanelAvailable}
          prop:onNavigate={(routeId: RouteId, options?: ApplicationNavigationOptions) =>
            props.host.shellNavigation.navigate(routeId, options)
          }
          prop:onSelectSession={(sessionKey: string) =>
            props.host.shellNavigation.selectChatSession(sessionKey)
          }
          prop:onSlashCommand={(command: string) =>
            props.host.handleCommandPaletteSlashCommand(command)
          }
        />
      </Show>
      <Show when={state().debugDefined}>
        <openclaw-debug-overlay ref={(element) => (props.host.elements.debugOverlay = element)} />
      </Show>
      <Show when={!props.nativeEmbed && state().shortcutsDefined}>
        <openclaw-keyboard-shortcuts-dialog
          ref={(element) => (props.host.elements.keyboardShortcuts = element)}
          prop:sendShortcut={state().sendShortcut}
          prop:newSessionHost={props.host}
        />
      </Show>
    </>
  );
}
