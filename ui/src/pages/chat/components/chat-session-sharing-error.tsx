import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Show } from "solid-js";
import { formatUiError } from "../../../lib/format-error.ts";

export function ChatSessionSharingError(props: {
  error?: string;
  completion?: Promise<void>;
  pending?: boolean;
  children: (message: string) => JSX.Element;
}) {
  // Keep the promise inside a receipt: a bare Promise used as Show's condition is awaited.
  const attempt = createMemo(() => props.completion && { result: props.completion });
  return (
    <Show
      when={props.error}
      fallback={
        <Show when={!props.pending}>
          <Show when={attempt()} keyed>
            {(receipt) => {
              const outcome = createMemo(() => receipt.result.then(() => null), {
                loadingValue: null,
              });
              return (
                <Errored fallback={(error) => <>{props.children(formatUiError(error()))}</>}>
                  {outcome()}
                </Errored>
              );
            }}
          </Show>
        </Show>
      }
    >
      {(error) => <>{props.children(error())}</>}
    </Show>
  );
}
