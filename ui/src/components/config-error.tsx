import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Show } from "solid-js";
import { formatUiError, UserFacingError } from "../lib/format-error.ts";

/** Callers retain the command's pending lifetime and existing error layout. */
export function ConfigError(props: {
  message: string | null | undefined;
  children: (message: string) => JSX.Element;
  fallback?: JSX.Element;
}) {
  function Failure(failure: { message: string }) {
    const readFailure = createMemo(() => {
      throw new UserFacingError(failure.message);
    });
    return (
      <Errored fallback={(error) => props.children(formatUiError(error()))}>
        {readFailure()}
      </Errored>
    );
  }
  return (
    <Show when={props.message} keyed fallback={props.fallback}>
      {(message) => <Failure message={message} />}
    </Show>
  );
}
