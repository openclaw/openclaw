import { Errored, Loading, onSettled, type Element } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyElementModal } from "../../../components/solid/lazy-view-error.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

/** Pending or failed optional chunks retain native cancellation and focus ownership. */
export function VoiceSnippetDialogBoundary(props: {
  signal: AbortSignal;
  onClose: () => void;
  children: Element;
}) {
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  const label = () => ({ label: t("chat.composer.voiceSnippets") });
  return (
    <Errored
      fallback={(error, reset) => (
        <LazyElementModal
          state={{
            status: "error",
            element: label(),
            error: error(),
            stale: isStaleChunkImportError(error()),
          }}
          onClose={() => props.onClose()}
          onRetry={() => {
            if (isStaleChunkImportError(error())) {
              void retryStaleChunkReloadWhenReachable({
                canReload: () => active && !props.signal.aborted,
              });
            } else {
              reset();
            }
          }}
        />
      )}
    >
      <Loading
        fallback={
          <LazyElementModal
            state={{ status: "loading", element: label() }}
            onRetry={() => {}}
            onClose={() => props.onClose()}
          />
        }
      >
        {props.children}
      </Loading>
    </Errored>
  );
}
