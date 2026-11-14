import { Portal } from "@solidjs/web";
import { LazyViewError } from "./solid/lazy-view-error.tsx";

/** Native and Solid entrypoints share the same retryable, viewport-owned failure UI. */
export function ImageLightboxError(props: {
  error: unknown;
  title?: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <Portal>
      <div
        style={{
          position: "fixed",
          right: "1rem",
          bottom: "1rem",
          width: "min(420px, calc(100vw - 2rem))",
          "z-index": "var(--z-toast)",
        }}
      >
        <LazyViewError
          error={props.error}
          subtitle={props.title}
          onRetry={() => props.onRetry()}
          onClose={() => props.onClose()}
          inline
        />
      </div>
    </Portal>
  );
}
