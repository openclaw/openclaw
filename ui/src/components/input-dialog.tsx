import {
  Errored,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  onSettled,
} from "solid-js";
import { formatUiError, UserFacingError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { InputDialogOptions } from "./input-dialog-types.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

export type { InputDialogOptions } from "./input-dialog-types.ts";

let inputActive = false;

/** Native prompts block reentrancy; reject a second request instead of stacking it. */
export function showInputDialog(options: InputDialogOptions): Promise<string | null> {
  if (inputActive) {
    return Promise.resolve(null);
  }
  inputActive = true;
  return withPromiseModalHost<string | null>({ signal: options.signal, value: null }, (modal) =>
    modal.render(() => renderInputDialog(options, modal.finish, () => modal.settled)),
  ).finally(() => {
    inputActive = false;
  });
}

function renderInputDialog(
  options: InputDialogOptions,
  finish: (value: string | null) => void,
  settled: () => boolean,
) {
  const gateway = options.gateway ? projectGateway(options.gateway) : undefined;
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
  const [rawValue, setRawValue] = createSignal(options.defaultValue ?? "");
  const entryValue = (raw: string) => (options.requireValue ? raw.trim() : raw);
  const submitBlocked = (raw: string) => {
    const value = entryValue(raw);
    const connected = gateway?.read().snapshot.phase === "connected";
    const canSubmit = options.canSubmit?.();
    return (
      canSubmit === false ||
      (gateway !== undefined && !connected && canSubmit !== true) ||
      (options.requireValue === true && !value.length) ||
      (options.requireChange === true && value === (options.defaultValue ?? ""))
    );
  };
  const presentSubmission = action(function* (
    value: string,
    result: Promise<string | null>,
  ): Generator<Promise<string | null>, void, string | null> {
    setSaving(true);
    try {
      if ((yield result) === null && !settled()) {
        finish(value);
      }
    } finally {
      submitting = false;
      onSettled(() => {
        if (!settled()) {
          input.focus();
        }
      });
    }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (settled() || submitting || submitBlocked(input.value)) {
      return;
    }
    const value = entryValue(input.value);
    const submitValue = options.submit;
    if (!submitValue) {
      finish(value);
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
    if (!settled()) {
      await presentSubmission(value, result);
    }
  }
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => input}
      label={options.title}
      description={options.label ?? options.title}
      onModal-cancel={(event: Event) => {
        if (submitting) {
          event.preventDefault();
        } else {
          finish(null);
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
          <button type="button" class="btn" disabled={saving()} onClick={() => finish(null)}>
            {options.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            type="submit"
            class="btn primary"
            disabled={saving() || submitBlocked(rawValue())}
          >
            {options.submitLabel ?? t("common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
