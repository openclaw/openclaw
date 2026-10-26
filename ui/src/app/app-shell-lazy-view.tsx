import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import type { RouteId } from "../app-routes.ts";
import type { LazyElementState } from "../components/solid/lazy-view-error.tsx";
import { t } from "../lib/reactive/i18n.ts";
import type { DebugOverlayFrameHost } from "../pages/debug/debug-overlay-frame.ts";
import { CommandPaletteLoading } from "./app-shell-command-palette-loading-view.tsx";
import type { CommandPaletteLoadingState } from "./app-shell-command-palette-loading.ts";
import { ShellLoadState, ShellRequestedComponent } from "./app-shell-component-boundary.tsx";
import type { ShellComponentHost, ShellOwnedElements } from "./app-shell-components.ts";
import type { ShellNavigationCapability } from "./app-shell-navigation.ts";
import type { ShellNewSessionHost } from "./app-shell-new-session.ts";
import type { ApplicationNavigationOptions } from "./context.ts";
import { normalizeChatSendShortcut } from "./settings.ts";

const PendingDebugOverlay = lazy(() => import("../pages/debug/debug-overlay-frame.ts"), {
  export: "renderPendingDebugOverlay",
});
const CommandPalette = lazy(() => import("../components/command-palette.tsx"), {
  export: "CommandPalette",
});
const DebugOverlay = lazy(() => import("../pages/debug/debug-overlay.ts"), {
  export: "DebugOverlay",
});
const KeyboardShortcuts = lazy(() => import("../components/keyboard-shortcuts-dialog.tsx"), {
  export: "KeyboardShortcutsDialog",
});

export type ShellElementAttributes<T extends HTMLElement = HTMLElement> =
  SolidJSX.HTMLAttributes<T> & { [property: `prop:${string}`]: unknown };

export interface ShellLazyOverlayHost
  extends DebugOverlayFrameHost, ShellNewSessionHost, ShellComponentHost {
  readonly elements: ShellOwnedElements;
  readonly shellNavigation: ShellNavigationCapability;
  readonly commandPaletteLoading: CommandPaletteLoadingState;
  closePendingPalette(): void;
  handleCommandPaletteSlashCommand(command: string): void;
}

/** Optional dialogs share shell intent; Solid owns each component import. */
export function ShellLazyOverlays(props: {
  host: ShellLazyOverlayHost;
  revision: number;
  desktopPanelAvailable: boolean;
  custodianPanelAvailable: boolean;
  nativeEmbed: boolean;
}): SolidJSX.Element {
  const sendShortcut = createMemo(() => {
    void props.revision;
    return normalizeChatSendShortcut(props.host.context?.theme.settings.chatSendShortcut);
  });
  const renderDebugState = (state: LazyElementState, retry: () => void, close: () => void) => (
    <Errored fallback={<ShellLoadState state={state} onRetry={retry} onClose={close} />}>
      <Loading>
        <PendingDebugOverlay
          host={props.host}
          state={state}
          mode={(props.revision, props.host.pendingDebugOverlayMode)}
          onRetry={retry}
          onClose={close}
        />
      </Loading>
    </Errored>
  );
  return (
    <>
      <ShellRequestedComponent
        host={props.host}
        component="palette"
        revision={props.revision}
        label="command palette"
        showLoading={false}
      >
        <Loading>
          <CommandPalette
            ref={(element) => {
              props.host.elements.commandPalette = element;
              props.host.shellComponentMounted(element);
            }}
            desktopAvailable={props.desktopPanelAvailable}
            custodianAvailable={props.custodianPanelAvailable}
            onNavigate={(routeId: RouteId, options?: ApplicationNavigationOptions) =>
              props.host.shellNavigation.navigate(routeId, options)
            }
            onSelectSession={(sessionKey: string) =>
              props.host.shellNavigation.selectChatSession(sessionKey)
            }
            onSlashCommand={(command: string) =>
              props.host.handleCommandPaletteSlashCommand(command)
            }
          />
        </Loading>
        {/* Keep the same input mounted while the component loads and composition settles. */}
        <Show when={props.host.commandPaletteLoading.active()}>
          <CommandPaletteLoading
            state={props.host.commandPaletteLoading}
            onClose={() => props.host.closePendingPalette()}
            retryStale={(canReload) => props.host.retryPendingLazyAction(canReload)}
          />
        </Show>
      </ShellRequestedComponent>
      <ShellRequestedComponent
        host={props.host}
        component="debug"
        revision={props.revision}
        label={t("debug.overlay.title")}
        renderLoadState={renderDebugState}
      >
        <DebugOverlay
          ref={(element) => {
            props.host.elements.debugOverlay = element;
            props.host.shellComponentMounted(element);
          }}
        />
      </ShellRequestedComponent>
      <Show when={!props.nativeEmbed}>
        <ShellRequestedComponent
          host={props.host}
          component="shortcuts"
          revision={props.revision}
          label={t("shortcutsOverlay.title")}
        >
          <KeyboardShortcuts
            ref={(element) => {
              props.host.elements.keyboardShortcuts = element;
              props.host.shellComponentMounted(element);
            }}
            sendShortcut={sendShortcut()}
            newSessionHost={props.host}
          />
        </ShellRequestedComponent>
      </Show>
    </>
  );
}
