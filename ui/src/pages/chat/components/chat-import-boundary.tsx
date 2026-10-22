import {
  createMemo,
  createSignal,
  Errored,
  Loading,
  onSettled,
  Show,
  type Element,
} from "solid-js";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";

/** Retire failed-import recovery with its source without remounting loaded content. */
export function ChatImportBoundary(props: {
  children: Element;
  identity: readonly unknown[];
  fallback: () => Element;
  connected?: () => boolean;
  subtitle?: string;
}) {
  const [attempt, setAttempt] = createSignal(0);
  return (
    <Loading on={attempt()} fallback={props.fallback()}>
      <Errored
        fallback={(error, reset) => {
          const source = createMemo(() => [error(), ...props.identity], {
            equals: (before, after) => before.every((value, index) => value === after[index]),
          });
          return (
            <Show when={source()} keyed>
              {(failedSource) => {
                const failure = failedSource[0];
                const stale = isStaleChunkImportError(failure);
                const [recovery, setRecovery] = createSignal<Promise<boolean>>();
                const recovered = createMemo(() => recovery());
                let active = true;
                let retryButton: HTMLButtonElement | undefined;
                onSettled(() => () => {
                  active = false;
                  if (stale) {
                    cancelStaleChunkRecovery();
                  }
                });
                const retryImport = () => {
                  setAttempt((value) => value + 1);
                  reset();
                };
                const retry = () => {
                  if (!active || !(props.connected?.() ?? retryButton?.isConnected)) {
                    return;
                  }
                  if (!stale) {
                    retryImport();
                    return;
                  }
                  const isCurrent = () =>
                    active && source() === failedSource && (props.connected?.() ?? true);
                  void setRecovery(
                    retryStaleChunkReloadWhenReachable({ canReload: isCurrent }).then(
                      (reloading) => {
                        if (!reloading && isCurrent()) {
                          retryImport();
                        }
                        return reloading;
                      },
                    ),
                  );
                };
                return (
                  <Loading on={recovery()} fallback={props.fallback()}>
                    {recovered()}
                    <LazyViewError
                      error={failure}
                      stale={stale}
                      subtitle={props.subtitle}
                      onRetry={retry}
                      retryRef={(element) => (retryButton = element)}
                    />
                  </Loading>
                );
              }}
            </Show>
          );
        }}
      >
        {props.children}
      </Errored>
    </Loading>
  );
}
