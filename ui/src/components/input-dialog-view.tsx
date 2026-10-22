import {
  Errored,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  onSettled,
  untrack,
} from "solid-js";
import { formatUiError, UserFacingError } from "../lib/format-error.ts";
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
  // Admission stays synchronous; Solid only owns the submission's presentation.
  let submitting = false;
  const [saving, setSaving] = createOptimistic(false);
  const [completion, setCompletion] = createSignal<Promise<string | null>>();
  const message = createMemo(() => completion() ?? null, { loadingValue: null });
  const invalid = createMemo(
    () =>
      completion()?.then(
        (value) => Boolean(value),
        () => true,
      ) ?? false,
    { loadingValue: false },
  );
  const [rawValue, setRawValue] = createSignal(initialOptions.defaultValue ?? "");
  const entryValue = (raw: string) => (initialOptions.requireValue ? raw.trim() : raw);
  const submitBlocked = (raw: string) => {
    const value = entryValue(raw);
    const connected = gateway?.read().snapshot.phase === "connected";
    const canSubmit = initialOptions.canSubmit?.();
    return (
      canSubmit === false ||
      (gateway !== undefined && !connected && canSubmit !== true) ||
      (initialOptions.requireValue === true && !value.length) ||
      (initialOptions.requireChange === true && value === (initialOptions.defaultValue ?? ""))
    );
  };
  const presentSubmission = action(function* (
    value: string,
    result: Promise<string | null>,
  ): Generator<Promise<string | null>, void, string | null> {
    setSaving(true);
    try {
      if ((yield result) === null && !props.settled()) {
        props.finish(value);
      }
    } finally {
      submitting = false;
      onSettled(() => {
        if (!props.settled()) {
          input.focus();
        }
      });
    }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (props.settled() || submitting || submitBlocked(input.value)) {
      return;
    }
    const value = entryValue(input.value);
    const submitValue = initialOptions.submit;
    if (!submitValue) {
      props.finish(value);
      return;
    }
    submitting = true;
    let result: Promise<string | null>;
    try {
      result = submitValue(value);
    } catch (error) {
      result = Promise.reject(
        error instanceof Error ? error : new UserFacingError(formatUiError(error)),
      );
    }
    void setCompletion(result);
    // Keep the admitted rejection handled if retirement precedes presentation.
    void result.catch(() => undefined);
    // Let synchronous owner publications land before the presentation joins this tick.
    await Promise.resolve();
    if (!props.settled()) {
      await presentSubmission(value, result);
    }
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
          // The outcome slot observes rejection; consume it even if the modal retires.
          void submit(event).catch(() => undefined);
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
            disabled={saving()}
            aria-invalid={!saving() && invalid() ? "true" : undefined}
            onInput={(event) => setRawValue(event.currentTarget.value)}
            autofocus
          />
        </label>
        <Show when={!saving()}>
          <Errored
            fallback={(error) => (
              <div class="exec-approval-error" role="alert">
                {formatUiError(error())}
              </div>
            )}
          >
            <Show when={message()}>
              <div class="exec-approval-error" role="alert">
                {message()}
              </div>
            </Show>
          </Errored>
        </Show>
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn" disabled={saving()} onClick={() => props.finish(null)}>
            {initialOptions.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            type="submit"
            class="btn primary"
            disabled={saving() || submitBlocked(rawValue())}
          >
            {initialOptions.submitLabel ?? t("common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
