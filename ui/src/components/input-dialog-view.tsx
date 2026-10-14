import { createMemo, createSignal, untrack } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { InputDialogOptions } from "./input-dialog-types.ts";

export function InputDialogView(props: {
  options: InputDialogOptions;
  finish(value: string | null): void;
  settled: () => boolean;
}) {
  const options = untrack(() => props.options);
  const settled = untrack(() => props.settled);
  let input!: HTMLInputElement;
  let submitting = false;
  let failure: string | null = null;
  const [revision, setRevision] = createSignal(0);
  const [rawValue, setRawValue] = createSignal(options.defaultValue ?? "");
  const state = createMemo(() => {
    revision();
    return { submitting, failure };
  });
  const entryValue = (raw: string) => (options.requireValue ? raw.trim() : raw);
  const submitBlocked = (raw: string) => {
    const value = entryValue(raw);
    return (
      (options.requireValue === true && !value.length) ||
      (options.requireChange === true && value === (options.defaultValue ?? ""))
    );
  };
  const paint = () => setRevision((value) => value + 1);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting || submitBlocked(input.value)) {
      return;
    }
    const value = entryValue(input.value);
    if (!options.submit) {
      props.finish(value);
      return;
    }
    submitting = true;
    failure = null;
    paint();
    let message: string | null;
    try {
      message = await options.submit(value);
    } catch (error) {
      message = formatUiError(error);
    }
    if (settled()) {
      return;
    }
    submitting = false;
    if (message === null) {
      props.finish(value);
      return;
    }
    failure = message;
    paint();
    // The view update re-enables the input before restoring its editing focus.
    queueMicrotask(() => {
      if (!settled()) {
        input.focus();
      }
    });
  }
  return (
    <openclaw-modal-dialog
      label={options.title}
      description={options.label ?? options.title}
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
          <div class="exec-approval-title">{options.title}</div>
        </div>
        <label class="field input-dialog__field">
          <span>{options.label ?? options.title}</span>
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
        <div class="exec-approval-actions">
          <button
            type="submit"
            class="btn primary"
            disabled={state().submitting || submitBlocked(rawValue())}
          >
            {options.submitLabel ?? t("common.save")}
          </button>
          <button
            type="button"
            class="btn"
            disabled={state().submitting}
            onClick={() => props.finish(null)}
          >
            {options.cancelLabel ?? t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  );
}
