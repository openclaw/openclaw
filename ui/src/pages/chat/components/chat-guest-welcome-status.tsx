import { Show } from "solid-js";
import type { GuestWelcomeHandle } from "../../../app/guest-welcome-handle.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";

/** Non-blocking welcome-session setup progress in the composer status lane. */
export function renderGuestWelcomeStatus(owner: GuestWelcomeHandle) {
  const state = projectOwner(owner, (current) => current.presentation);
  const failed = () => {
    const current = state.read();
    return current.kind === "failed" ? current : undefined;
  };
  return (
    <>
      <Show when={state.read().kind === "pending"}>
        <div class="agent-chat__composer-status chat-guest-welcome-status" data-tone="info">
          <div
            class="agent-chat__composer-status-band"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <span class="agent-chat__composer-status-icon" aria-hidden="true">
              <span class="btn__spinner" />
            </span>
            <span class="agent-chat__composer-status-text">
              {t("chat.sessionSharing.guestWelcomePending")}
            </span>
          </div>
        </div>
      </Show>
      <Show when={failed()}>
        {(current) => (
          <div class="agent-chat__composer-status chat-guest-welcome-status" data-tone="danger">
            <div
              class="agent-chat__composer-status-band agent-chat__composer-status-band--wrap"
              role="alert"
            >
              <span class="agent-chat__composer-status-icon" aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <span class="agent-chat__composer-status-text" title={current().message ?? undefined}>
                {current().message
                  ? `${t("chat.sessionSharing.guestWelcomeFailed")} ${current().message}`
                  : t("chat.sessionSharing.guestWelcomeFailed")}
              </span>
              <button type="button" class="btn btn--sm" onClick={() => owner.retry()}>
                {t("chat.sessionSharing.guestWelcomeRetry")}
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
