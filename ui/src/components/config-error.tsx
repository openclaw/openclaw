import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Show } from "solid-js";
import { formatUiError, formatUiErrorDetails, UserFacingError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";

/** Raw failures stay redacted and opt-in, separate from the recovery summary. */
export function ErrorDetails(props: { error: unknown }) {
  const detail = createMemo(() => (props.error == null ? "" : formatUiErrorDetails(props.error)));
  return (
    <Show when={detail()} keyed>
      {(message) => (
        <details class="lazy-view-error__details">
          <summary>{t("common.showDetails")}</summary>
          <code class="lazy-view-error__detail">{message}</code>
        </details>
      )}
    </Show>
  );
}

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
