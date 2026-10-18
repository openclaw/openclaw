import { render, type JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import { Icon } from "./solid/icon.tsx";

type SecretRevealDialogOptions = {
  title: string;
  message: string;
  /** No secret means normal dismissal: there is nothing for the operator to lose. */
  secret?: string;
  acknowledgeLabel: string;
  dismissHint?: string;
  status?: "success";
  callout?: string;
  note?: string;
};

/** Keep one-time secrets visible until acknowledged, announcing refused dismissal. */
export function showSecretRevealDialog(options: SecretRevealDialogOptions): Promise<void> {
  return withPromiseModalHost<void, JSX.Element>(
    undefined,
    (modal) => {
      modal.render(() => {
        const [dismissRefused, setDismissRefused] = createSignal(false);
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
            label={options.title}
            description={options.message}
            onModal-cancel={cancel}
          >
            <div class="exec-approval-card">
              <div class="secret-reveal__header">
                <Show when={options.status === "success"}>
                  <span class="secret-reveal__status" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                </Show>
                <div class="exec-approval-title">{options.title}</div>
              </div>
              <div class="secret-reveal__body">
                <p>{options.message}</p>
              </div>
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
              <div class="exec-approval-actions">
                <button
                  type="button"
                  class={options.secret ? "btn primary" : "btn secret-reveal__dismiss"}
                  autofocus
                  onClick={acknowledge}
                >
                  {options.acknowledgeLabel}
                </button>
              </div>
            </div>
          </openclaw-modal-dialog>
        );
      });
    },
    render,
  );
}
