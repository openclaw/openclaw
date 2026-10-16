import { createComponent, createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  clearLazyShellAction,
  persistLazyShellAction,
  readLazyShellAction,
} from "../../app/lazy-shell-action.ts";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { DebugOverlayFrame } from "./debug-overlay-frame-view.tsx";
import { DebugOverlayLoading } from "./debug-overlay-loading-view.tsx";
import { shouldCloseDebugOverlay, type DebugOverlayMode } from "./debug-overlay-state.ts";

type Props = {
  context: ApplicationContext | undefined;
  mode: DebugOverlayMode | "closed";
  contentKey: number;
};
type Methods = { open(mode: DebugOverlayMode): void; toggle(): void };

function Overlay(props: Props, host: SolidBridgeElement<Props, Methods>) {
  const inherited = untrack(() => props.context) ? undefined : useApplication();
  const close = () => {
    host.mode = "closed";
  };
  const [Content, setContent] =
    createSignal<typeof import("./debug-overlay-content.ts").DebugOverlayContent>();
  const [error, setError] = createSignal<{ error: unknown; stale: boolean } | null>(null);
  let disposed = false;
  let request: { stale: boolean } | undefined;
  let recoveryActionPending = false;
  const clearRecoveryAction = () => {
    if (!recoveryActionPending) {
      return;
    }
    if (readLazyShellAction()?.eventType === DEBUG_OVERLAY_REQUEST_EVENT) {
      clearLazyShellAction();
    }
    recoveryActionPending = false;
  };
  const cancel = () => {
    if (request?.stale) {
      cancelStaleChunkRecovery();
    }
    request = undefined;
    clearRecoveryAction();
  };
  async function load(recover = false) {
    const current = { stale: recover };
    request = current;
    setError(null);
    try {
      if (
        recover &&
        (await retryStaleChunkReloadWhenReachable({
          canReload: () => {
            if (request !== current) {
              return false;
            }
            recoveryActionPending = persistLazyShellAction({
              eventType: DEBUG_OVERLAY_REQUEST_EVENT,
            });
            return recoveryActionPending;
          },
        }))
      ) {
        return;
      }
      if (request !== current) {
        return;
      }
      const module = await import("./debug-overlay-content.ts");
      // Registration survives dismissal; a later open reuses this lazy renderer.
      if (!disposed) {
        setContent(() => module.DebugOverlayContent);
      }
      if (request === current) {
        cancel();
      }
    } catch (failure) {
      if (request === current) {
        current.stale = isStaleChunkImportError(failure);
        setError({ error: failure, stale: current.stale });
      }
    }
  }
  const keydown = (event: KeyboardEvent) => {
    if (shouldCloseDebugOverlay(event, host.mode, host)) {
      event.preventDefault();
      close();
    }
  };
  createEffect(
    () => ({ mode: props.mode, key: props.contentKey, loaded: Boolean(Content()) }),
    (current, previous) => {
      if (current.mode === "closed") {
        cancel();
        setError(null);
        return undefined;
      }
      document.addEventListener("keydown", keydown, true);
      if (current.key !== previous?.key && !current.loaded) {
        cancel();
        recoveryActionPending = persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
        void load();
      }
      return () => document.removeEventListener("keydown", keydown, true);
    },
  );
  onCleanup(() => {
    disposed = true;
    cancel();
    if (!host.isConnected) {
      close();
    }
  });
  return (
    <Show when={props.mode !== "closed"}>
      <DebugOverlayFrame
        mode={props.mode === "minimized" ? "minimized" : "expanded"}
        onToggleMode={() => {
          host.mode = host.mode === "minimized" ? "expanded" : "minimized";
        }}
        onClose={close}
        body={
          <Show
            when={!error()}
            fallback={
              <LazyViewError
                actionLabel={t("common.retry")}
                error={error()?.error}
                stale={error()?.stale}
                subtitle={t("debug.overlay.title")}
                onRetry={() => void load(error()?.stale)}
              />
            }
          >
            <Show
              when={Content()}
              keyed
              fallback={
                <Show when={props.mode === "minimized"} fallback={<DebugOverlayLoading />}>
                  <div class="debug-overlay__compact-loading" role="status">
                    {t("common.loading")}
                  </div>
                </Show>
              }
            >
              {(component) => (
                <Show when={props.contentKey + 1} keyed>
                  {(_contentKey) =>
                    createComponent(component, {
                      get context() {
                        return props.context ?? inherited;
                      },
                      get minimized() {
                        return props.mode === "minimized";
                      },
                    })
                  }
                </Show>
              )}
            </Show>
          </Show>
        }
      />
    </Show>
  );
}

export const DebugOverlay = defineSolidBridge<Props, Methods>("openclaw-debug-overlay", Overlay, {
  properties: {
    context: { default: undefined, attribute: false },
    mode: { default: "closed", attribute: false },
    contentKey: { default: 0, attribute: false },
  },
  methods: {
    open: (host, mode) => {
      if (host.mode === "closed") {
        host.contentKey += 1;
      }
      host.mode = mode;
    },
    toggle: (host) => {
      if (host.mode === "expanded") {
        host.mode = "closed";
      } else {
        host.open("expanded");
      }
    },
  },
});
