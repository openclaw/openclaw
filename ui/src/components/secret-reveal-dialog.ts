import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";
import { icons } from "./icons.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";

type SecretRevealDialogOptions = {
  title: string;
  message: string;
  /** Omitted when the operation issued no secret to this operator; the dialog then
   *  reports the outcome only, and dismissal gestures behave normally. */
  secret?: string;
  acknowledgeLabel: string;
  /** Only reachable with a secret, because only then is dismissal refused. */
  dismissHint?: string;
  /** Success mark beside the title. Set only where the dialog reports a settled outcome;
   *  a reveal that still needs the operator to act should not look finished. */
  status?: "success";
  /** Optional guidance displayed as an info callout. */
  callout?: string;
  /** Muted trailing rationale. */
  note?: string;
};

/**
 * Resolves on the explicit acknowledgement. With a secret, Escape and backdrop cannot
 * settle it; without one there is nothing to lose, so they close it like any dialog.
 */
export function showSecretRevealDialog(options: SecretRevealDialogOptions): Promise<void> {
  return withPromiseModalHost<void>(undefined, ({ render, finish }) => {
    let dismissRefused = false;
    const acknowledge = () => finish();
    // Keep one-time secrets visible until acknowledged; announce refused dismissal accessibly.
    const handleCancel = (event: Event) => {
      if (!options.secret) {
        acknowledge();
        return;
      }
      event.preventDefault();
      if (dismissRefused) {
        return;
      }
      dismissRefused = true;
      paint();
    };
    const acknowledgeClass = options.secret ? "btn primary" : "btn secret-reveal__dismiss";
    const paint = () => {
      render(() => {
        return html`
          <openclaw-modal-dialog
            label=${options.title}
            description=${options.message}
            @modal-cancel=${handleCancel}
          >
            <div class="exec-approval-card">
              <div class="secret-reveal__header">
                ${
                  options.status === "success"
                    ? html`<span class="secret-reveal__status" aria-hidden="true"
                        >${icons.check}</span
                      >`
                    : nothing
                }
                <div class="exec-approval-title">${options.title}</div>
              </div>
              <div class="secret-reveal__body"><p>${options.message}</p></div>
              ${
                options.callout
                  ? html`<div class="callout info secret-reveal__callout">${options.callout}</div>`
                  : nothing
              }
              ${
                options.secret
                  ? html`
                      <div class="secret-reveal__value">
                        <code class="secret-reveal__code">${options.secret}</code>
                        ${renderCopyButton(options.secret, t("common.copy"))}
                      </div>
                    `
                  : nothing
              }
              ${
                dismissRefused
                  ? html`<p class="secret-reveal__hint" role="status">${options.dismissHint}</p>`
                  : nothing
              }
              ${options.note ? html`<p class="secret-reveal__note">${options.note}</p>` : nothing}
              <div class="exec-approval-actions">
                <button type="button" class=${acknowledgeClass} autofocus @click=${acknowledge}>
                  ${options.acknowledgeLabel}
                </button>
              </div>
            </div>
          </openclaw-modal-dialog>
        `;
      });
    };
    paint();
  });
}
