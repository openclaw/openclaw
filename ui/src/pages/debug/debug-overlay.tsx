import { action, createOptimistic, Errored, lazy, Loading, onSettled, Show } from "solid-js";
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

function Overlay(props: Props, host: SolidBridgeElement<Props, Methods>) {
  // A bridge's provider ancestry is fixed for this renderer lifetime.
  const inherited = useOptionalApplication();
  const close = () => {
    host.mode = "closed";
  };
  const Content = lazy(() => import("./debug-overlay-content.ts"), {
    export: "DebugOverlayContent",
  });
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
  function preload() {
    const current = { stale: false };
    request = current;
    recoveryActionPending = persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
    // Replay belongs to this open; lazy owns the shared import and its presentation.
    void Content.preload().then(
      () => {
        if (request === current) {
          cancel();
        }
      },
      (failure: unknown) => {
        if (request === current) {
          current.stale = isStaleChunkImportError(failure);
        }
      },
    );
  }
  async function recover(failure: unknown, reset: () => void) {
    const current = { stale: isStaleChunkImportError(failure) };
    request = current;
    if (
      current.stale &&
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
    if (request === current) {
      preload();
      reset();
    }
  }
  function PendingContent() {
    return (
      <Show when={props.mode === "minimized"} fallback={<DebugOverlayLoading />}>
        <div class="debug-overlay__compact-loading" role="status">
          {t("common.loading")}
        </div>
      </Show>
    );
  }
  function ImportError(errorProps: { error: unknown; reset: () => void }) {
    const [retrying, setRetrying] = createOptimistic(false);
    const retry = action(function* () {
      setRetrying(true);
      yield recover(errorProps.error, errorProps.reset);
    });
    return (
      <Show when={!retrying()} fallback={<PendingContent />}>
        <LazyViewError
          actionLabel={t("common.retry")}
          error={errorProps.error}
          stale={isStaleChunkImportError(errorProps.error)}
          subtitle={t("debug.overlay.title")}
          onRetry={() => void retry()}
        />
      </Show>
    );
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
      if (host.contentKey !== previousKey) {
        cancel();
        preload();
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
              <Errored fallback={(error, reset) => <ImportError error={error()} reset={reset} />}>
                <Loading fallback={<PendingContent />}>
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
