import { createSignal, untrack } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { InputDialogOptions } from "./input-dialog-types.ts";

export function InputDialogView(props: {
  options: InputDialogOptions;
  finish(value: string | null): void;
  settled: () => boolean;
}) {
  // A prompt keeps its submitted request and default for its entire lifetime.
  const initialOptions = untrack(() => props.options);
  const gateway = initialOptions.gateway ? projectGateway(initialOptions.gateway) : undefined;
  let input!: HTMLInputElement;
  // Submission admission stays synchronous; signals publish the visible state.
  let submitting = false;
  const [state, setState] = createSignal<{ submitting: boolean; failure: string | null }>({
    submitting: false,
    failure: null,
  });
  const [rawValue, setRawValue] = createSignal(initialOptions.defaultValue ?? "");
  const entryValue = (raw: string) => (initialOptions.requireValue ? raw.trim() : raw);
  const submitBlocked = (raw: string) => {
    const value = entryValue(raw);
    return (
      initialOptions.canSubmit?.() === false ||
      (gateway !== undefined && gateway.read().snapshot.phase !== "connected") ||
      (initialOptions.requireValue === true && !value.length) ||
      (initialOptions.requireChange === true && value === (initialOptions.defaultValue ?? ""))
    );
  };
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (props.settled() || submitting || submitBlocked(input.value)) {
      return;
    }
    const value = entryValue(input.value);
    if (!initialOptions.submit) {
      props.finish(value);
      return;
    }
    submitting = true;
    setState({ submitting: true, failure: null });
    let message: string | null;
    try {
      message = await initialOptions.submit(value);
    } catch (error) {
      message = formatUiError(error);
    }
    if (props.settled()) {
      return;
    }
    submitting = false;
    if (message === null) {
      props.finish(value);
      return;
    }
    setState({ submitting: false, failure: message });
    // The view update re-enables the input before restoring its editing focus.
    queueMicrotask(() => {
      if (!props.settled()) {
        input.focus();
      }
    });
  }
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => input}
      label={initialOptions.title}
      description={initialOptions.label ?? initialOptions.title}
      onModal-cancel={(event: Event) => {
        if (submitting) {
          event.preventDefault();
        } else {
          props.finish(null);
        }
      }}
    >
      <form
        class="exec-approval-card"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div class="exec-approval-header">
          <div class="exec-approval-title">{initialOptions.title}</div>
        </div>
        <label class="field input-dialog__field">
          <span>{initialOptions.label ?? initialOptions.title}</span>
          <input
            ref={(element) => {
              input = element;
            }}
            name="value"
            type="text"
            autocomplete="off"
            spellcheck="false"
            value={rawValue()}
            disabled={state().submitting}
            aria-invalid={state().failure ? "true" : undefined}
            onInput={(event) => setRawValue(event.currentTarget.value)}
            autofocus
          />
        </label>
        {state().failure ? (
          <div class="exec-approval-error" role="alert">
            {state().failure}
          </div>
        ) : undefined}
        <openclaw-modal-actions class="exec-approval-actions">
          <button
            type="submit"
            class="btn primary"
            disabled={state().submitting || submitBlocked(rawValue())}
          >
            {initialOptions.submitLabel ?? t("common.save")}
          </button>
          <button
            type="button"
            class="btn"
            disabled={state().submitting}
            onClick={() => props.finish(null)}
          >
            {initialOptions.cancelLabel ?? t("common.cancel")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
