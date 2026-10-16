import { Dynamic, type JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, Show } from "solid-js";
import type { RouteId } from "../app-routes.ts";
import { LazyElementModal } from "../components/solid/lazy-view-error.tsx";
import type { DebugOverlayFrameHost } from "../pages/debug/debug-overlay-frame.ts";
import { CommandPaletteLoading } from "./app-shell-command-palette-loading-view.tsx";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
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

/** Unported elements receive properties explicitly until their own lanes land. */
export type ShellElementAttributes = SolidJSX.HTMLAttributes<HTMLElement> & {
  [property: `prop:${string}`]: unknown;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-command-palette": ShellElementAttributes;
      "openclaw-debug-overlay": ShellElementAttributes;
      "openclaw-keyboard-shortcuts-dialog": ShellElementAttributes;
    }
  }
}

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
      debugRenderer: props.host.debugOverlayFrame.renderer,
      debugFrameFailed: props.host.debugOverlayFrame.failed,
      debugMode: props.host.pendingDebugOverlayMode,
      shortcutsDefined: isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT),
      sendShortcut: normalizeChatSendShortcut(props.host.context?.theme.settings.chatSendShortcut),
    };
  });
  createEffect(
    () => {
      const current = state();
      return (
        current.lazy?.element === DEBUG_OVERLAY_ELEMENT &&
        !current.debugRenderer &&
        !current.debugFrameFailed
      );
    },
    (shouldLoad) => {
      if (shouldLoad) {
        props.host.debugOverlayFrame.load();
      }
    },
  );
  const paletteLoading = createMemo(() => {
    const current = state();
    return (
      current.paletteLoading &&
      (!current.lazy ||
        (current.lazy.status === "loading" &&
          current.lazy.element === props.host.commandPaletteElement))
    );
  });
  const pendingDebug = createMemo(() => {
    const current = state();
    return current.lazy?.element === DEBUG_OVERLAY_ELEMENT ? current.lazy : undefined;
  });
  const onClose = () => props.host.closePendingPalette();
  return (
    <>
      <Show
        when={paletteLoading()}
        fallback={
          <Show
            when={pendingDebug() && state().debugRenderer}
            fallback={
              <Show when={!pendingDebug() || state().debugFrameFailed}>
                <LazyElementModal
                  state={state().lazy}
                  onRetry={() => props.host.lazyCustomElements.retry()}
                  onClose={() => props.host.lazyCustomElements.close()}
                />
              </Show>
            }
          >
            {(renderer) => (
              <Dynamic
                component={renderer()}
                host={props.host}
                state={pendingDebug()!}
                mode={state().debugMode}
              />
            )}
          </Show>
        }
      >
        <CommandPaletteLoading
          state={props.host.commandPaletteLoading}
          revision={state().revision}
          onClose={onClose}
        />
      </Show>
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
        <openclaw-debug-overlay />
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
