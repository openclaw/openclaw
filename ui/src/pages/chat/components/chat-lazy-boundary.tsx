import { Errored, Loading, type Element } from "solid-js";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { ReportDesktopDetailsContent } from "./chat-details-content-presence.ts";

/** A failed optional chat region must not retire the pane or its composer. */
export function ChatLazyBoundary(props: {
  children: Element;
  fallback?: Element;
  onClose?: () => void;
}) {
  return (
    <Errored
      fallback={(error, reset) => (
        <>
          <ReportDesktopDetailsContent />
          <LazyViewError
            error={error()}
            stale={isStaleChunkImportError(error())}
            onRetry={() =>
              isStaleChunkImportError(error()) ? void retryStaleChunkReloadWhenReachable() : reset()
            }
            onClose={props.onClose}
            inline
          />
        </>
      )}
    >
      <Loading fallback={props.fallback}>{props.children}</Loading>
    </Errored>
  );
}
