import { createComponent, createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "../../app/lazy-custom-element.ts";
import {
  clearLazyShellAction,
  persistLazyShellAction,
  readLazyShellAction,
} from "../../app/lazy-shell-action.ts";
import { retryStaleChunkReloadWhenReachable } from "../../app/stale-chunk-reload.ts";
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
  const [loadRevision, setLoadRevision] = createSignal(0, { ownedWrite: true });
  const [Content, setContent] =
    createSignal<typeof import("./debug-overlay-content.ts").DebugOverlayContent>();
  let disposed = false;
  const CONTENT = {
    tagName: "openclaw-debug-overlay-content",
    get label() {
      return t("debug.overlay.title");
    },
    loadModule: async () => {
      const module = await import("./debug-overlay-content.ts");
      if (!disposed) {
        setContent(() => module.DebugOverlayContent);
      }
    },
  } satisfies OptionalCustomElement;
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
  const content = new LazyCustomElementRequestController(
    {
      requestUpdate: () => setLoadRevision((value) => value + 1),
    },
    undefined,
    (canReload) =>
      retryStaleChunkReloadWhenReachable({
        canReload: () => {
          if (!canReload()) {
            return false;
          }
          recoveryActionPending = persistLazyShellAction({
            eventType: DEBUG_OVERLAY_REQUEST_EVENT,
          });
          return recoveryActionPending;
        },
      }),
  );
  const clear = () => {
    document.removeEventListener("keydown", keydown, true);
    content.close();
    clearRecoveryAction();
  };
  const keydown = (event: KeyboardEvent) => {
    if (shouldCloseDebugOverlay(event, host.mode, host)) {
      event.preventDefault();
      close();
    }
  };
  createEffect(
    () => ({ mode: props.mode, key: props.contentKey, revision: loadRevision() }),
    (current, previous) => {
      if (current.mode === "closed") {
        clear();
        return;
      }
      document.addEventListener("keydown", keydown, true);
      if (current.key !== previous?.key && !isOptionalElementDefined(CONTENT)) {
        content.close();
        recoveryActionPending = persistLazyShellAction({ eventType: DEBUG_OVERLAY_REQUEST_EVENT });
        content.request(CONTENT, clearRecoveryAction);
      }
      // Another requester may have registered the shared lazy module for this root.
      if (isOptionalElementDefined(CONTENT) && !untrack(Content)) {
        void CONTENT.loadModule();
      }
    },
  );
  onCleanup(() => {
    disposed = true;
    clear();
    if (!host.isConnected) {
      close();
    }
  });
  const error = () => {
    loadRevision();
    const state = content.visibleState;
    return state?.status === "error" ? state : null;
  };
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
                subtitle={error()?.element.label}
                onRetry={() => content.retry()}
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
