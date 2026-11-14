import "../styles/secret-reveal.css";
import { createSignal, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import { DialogHeader } from "./solid/dialog-header.tsx";

/** Keep one-time secrets visible until acknowledged, announcing refused dismissal. */
export function showSecretRevealDialog(options: {
  title: string;
  message: string;
  /** No secret means normal dismissal: there is nothing for the operator to lose. */
  secret?: string;
  acknowledgeLabel: string;
  dismissHint?: string;
  callout?: string;
  note?: string;
}): Promise<void> {
  return withPromiseModalHost<void>(undefined, (modal) => {
    modal.render(() => {
      const [dismissRefused, setDismissRefused] = createSignal(false);
      let acknowledgeButton!: HTMLButtonElement;
      const acknowledge = () => modal.finish();
      const cancel = (event: Event) => {
        if (!options.secret) {
          acknowledge();
          return;
        }
        event.preventDefault();
        setDismissRefused(true);
      };
      return (
        <openclaw-modal-dialog
          prop:initialFocus={() => acknowledgeButton}
          label={options.title}
          description={options.message}
          onModal-cancel={cancel}
        >
          <div class="oc-dialog secret-reveal">
            <DialogHeader
              title={options.title}
              description={<p>{options.message}</p>}
              onClose={options.secret ? undefined : acknowledge}
            />
            <div class="oc-dialog__body">
              <Show when={options.callout}>
                <div class="callout info secret-reveal__callout">{options.callout}</div>
              </Show>
              <Show when={options.secret}>
                {(secret) => (
                  <div class="secret-reveal__value">
                    <code class="secret-reveal__code">{secret()}</code>
                    <CopyButton text={secret()} idleLabel={t("common.copy")} />
                  </div>
                )}
              </Show>
              <Show when={dismissRefused()}>
                <p class="secret-reveal__hint" role="status">
                  {options.dismissHint}
                </p>
              </Show>
              <Show when={options.note}>
                <p class="secret-reveal__note">{options.note}</p>
              </Show>
            </div>
            <openclaw-modal-actions class="oc-dialog__footer">
              <button
                ref={(element) => {
                  acknowledgeButton = element;
                }}
                type="button"
                class={options.secret ? "btn primary" : "btn"}
                autofocus
                onClick={acknowledge}
              >
                {options.acknowledgeLabel}
              </button>
            </openclaw-modal-actions>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
