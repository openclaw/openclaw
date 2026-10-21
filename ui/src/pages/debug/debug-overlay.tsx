import { Errored, lazy, Loading, onSettled, Show } from "solid-js";
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
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { DebugOverlayFrame } from "./debug-overlay-frame-view.tsx";
import { DebugOverlayLoading } from "./debug-overlay-loading-view.tsx";
import { shouldCloseDebugOverlay, type DebugOverlayMode } from "./debug-overlay-state.ts";

type Props = {
  context: ApplicationContext | undefined;
  mode: DebugOverlayMode | "closed";
  contentKey: number;
};
type Methods = { open(mode: DebugOverlayMode): void; toggle(): void };

const synchronizers = new WeakMap<HTMLElement, () => void>();
const Content = lazy(() => import("./debug-overlay-content.ts"), {
  export: "DebugOverlayContent",
});

function Overlay(props: Props, host: SolidBridgeElement<Props, Methods>) {
  // A bridge's provider ancestry is fixed for this renderer lifetime.
  const inherited = useOptionalApplication();
  const close = () => {
    host.mode = "closed";
  };
  let contentLoaded = false;
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
  async function load(recover = false, reset?: () => void) {
    const current = { stale: recover };
    request = current;
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
      reset?.();
      // Preloading retains registration after dismissal and retires reload intent.
      await Content.preload();
      contentLoaded = true;
      if (request === current) {
        cancel();
      }
    } catch (failure) {
      if (request === current) {
        current.stale = isStaleChunkImportError(failure);
        // The rendered lazy component reports the failure through Errored.
      }
    }
  }
  const keydown = (event: KeyboardEvent) => {
    if (shouldCloseDebugOverlay(event, host.mode, host)) {
      event.preventDefault();
      close();
    }
  };
  let previousKey: number | undefined;
  let stopKeydown: (() => void) | undefined;
  const synchronize = () => {
    stopKeydown?.();
    stopKeydown = undefined;
    if (host.mode === "closed") {
      cancel();
    } else {
      stopKeydown = listen(document, "keydown", keydown, true);
      if (host.contentKey !== previousKey && !contentLoaded) {
        cancel();
        recoveryActionPending = persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
        void load();
      }
    }
    previousKey = host.contentKey;
  };
  onSettled(() => {
    synchronizers.set(host, synchronize);
    synchronize();
    return () => {
      synchronizers.delete(host);
      stopKeydown?.();
      cancel();
      if (!host.isConnected) {
        close();
      }
    };
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
          <Show when={props.contentKey + 1} keyed>
            {(_contentKey) => (
              <Errored
                fallback={(error, reset) => (
                  <LazyViewError
                    actionLabel={t("common.retry")}
                    error={error()}
                    stale={isStaleChunkImportError(error())}
                    subtitle={t("debug.overlay.title")}
                    onRetry={() => void load(isStaleChunkImportError(error()), reset)}
                  />
                )}
              >
                <Loading
                  fallback={
                    <Show when={props.mode === "minimized"} fallback={<DebugOverlayLoading />}>
                      <div class="debug-overlay__compact-loading" role="status">
                        {t("common.loading")}
                      </div>
                    </Show>
                  }
                >
                  <Content
                    context={props.context ?? inherited}
                    minimized={props.mode === "minimized"}
                  />
                </Loading>
              </Errored>
            )}
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
  propertyChanged: (host, key) => {
    if (key === "mode" || key === "contentKey") {
      // Settle both writes from open() and retire the previous keyed content first.
      onSettled(() => synchronizers.get(host)?.());
    }
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
