import { createSignal, Errored, lazy, Loading, onSettled, Show, type Element } from "solid-js";
import {
  LazyElementModal,
  LazyElementStateView,
  type LazyElementState,
} from "../components/solid/lazy-view-error.tsx";
import {
  shellComponentForAction,
  type ShellComponent,
  type ShellComponentHost,
} from "./app-shell-components.ts";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "./stale-chunk-reload.ts";

type LoadStateRenderer = (state: LazyElementState, retry: () => void, close: () => void) => Element;

const ModalLoadState = lazy(async () => {
  await import("../components/modal-dialog.tsx");
  return { default: LazyElementModal };
});

/** A cold failure still needs the dialog's registration; its own failure stays visible inline. */
export function ShellLoadState(props: {
  state: LazyElementState;
  onRetry: () => void;
  onClose: () => void;
}) {
  const inline = () => (
    <LazyElementStateView state={props.state} onRetry={props.onRetry} onClose={props.onClose} />
  );
  return (
    <Errored fallback={inline}>
      <Loading fallback={inline()}>
        <ModalLoadState state={props.state} onRetry={props.onRetry} onClose={props.onClose} />
      </Loading>
    </Errored>
  );
}

/** Optional chrome owns loading/error presentation, without taking shell action custody. */
export function ShellComponentBoundary(props: {
  children: Element;
  label: string;
  showLoading?: boolean;
  loadingFallback?: Element;
  request?: unknown;
  visible?: boolean;
  onClose?: () => void;
  retryStale?: (canReload: () => boolean) => Promise<boolean>;
  renderLoadState?: LoadStateRenderer;
}) {
  const [dismissed, setDismissed] = createSignal<boolean>((previous) =>
    props.request ? false : (previous ?? false),
  );
  const [attempt, setAttempt] = createSignal(0);
  const close = () => {
    setDismissed(true);
    props.onClose?.();
  };
  const renderState: LoadStateRenderer = (state, retry, onClose) =>
    props.renderLoadState ? (
      props.renderLoadState(state, retry, onClose)
    ) : (
      <ShellLoadState state={state} onRetry={retry} onClose={onClose} />
    );
  return (
    <Loading
      on={attempt()}
      fallback={
        props.loadingFallback ?? (
          <Show when={props.showLoading && !dismissed()}>
            {renderState({ status: "loading", element: { label: props.label } }, () => {}, close)}
          </Show>
        )
      }
    >
      <Errored
        fallback={(error, reset) => (
          <Show when={!dismissed() && props.visible !== false}>
            {(_visible) => {
              let current = true;
              const stale = () => isStaleChunkImportError(error());
              onSettled(() => () => {
                current = false;
                if (stale()) {
                  cancelStaleChunkRecovery();
                }
              });
              const retry = async () => {
                const retryStale =
                  props.retryStale ??
                  ((canReload: () => boolean) => retryStaleChunkReloadWhenReachable({ canReload }));
                if (stale() && (await retryStale(() => current))) {
                  return;
                }
                if (current) {
                  setAttempt((value) => value + 1);
                  reset();
                }
              };
              return (
                <>
                  {renderState(
                    {
                      status: "error",
                      element: { label: props.label },
                      error: error(),
                      stale: stale(),
                    },
                    () => void retry(),
                    () => {
                      current = false;
                      if (stale()) {
                        cancelStaleChunkRecovery();
                      }
                      close();
                    },
                  )}
                </>
              );
            }}
          </Show>
        )}
      >
        {props.children}
      </Errored>
    </Loading>
  );
}

/** Requested components remain resident; readiness comes only from their mounted hosts. */
export function ShellRequestedComponent(props: {
  host: ShellComponentHost;
  component: ShellComponent;
  revision: number;
  label: string;
  children: Element;
  showLoading?: boolean;
  renderLoadState?: LoadStateRenderer;
}) {
  const request = () => {
    void props.revision;
    const event = props.host.pendingShellAction;
    return event && shellComponentForAction(event) === props.component ? event : null;
  };
  const actionOnly = () =>
    props.component === "palette" || props.component === "debug" || props.component === "shortcuts";
  return (
    <Show when={(props.revision, props.host.isShellComponentRequested(props.component))}>
      <ShellComponentBoundary
        label={props.label}
        request={request()}
        visible={
          (props.revision, Boolean(request()) || (!actionOnly() && !props.host.pendingShellAction))
        }
        showLoading={props.showLoading ?? Boolean(request())}
        renderLoadState={props.renderLoadState}
        retryStale={(canReload) => props.host.retryPendingLazyAction(canReload)}
        onClose={() => props.host.cancelShellComponentRequest(props.component)}
      >
        {props.children}
      </ShellComponentBoundary>
    </Show>
  );
}
