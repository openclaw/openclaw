import { Errored, Loading, type Element } from "solid-js";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";

/** A failed optional chat region must not retire the pane or its composer. */
export function ChatLazyBoundary(props: {
  children: Element;
  fallback?: Element;
  onClose?: () => void;
}) {
  return (
    <Errored
      fallback={(error, reset) => (
        <LazyViewError error={error()} onRetry={reset} onClose={props.onClose} inline />
      )}
    >
      <Loading fallback={props.fallback}>{props.children}</Loading>
    </Errored>
  );
}
