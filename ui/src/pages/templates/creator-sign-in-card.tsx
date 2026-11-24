import { createSignal, Show } from "solid-js";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { reserveExternalWindowForDeferredNavigation } from "../../lib/open-external-url.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { TemplateCreator, TemplateSignInPresentation } from "./creator-publication.ts";
import "../../styles/chat/clawhub-card.css";

const clawHubLogo = new URL("./clawhub-logo.png", import.meta.url).href;

export function TemplateCreatorSignInCard(props: {
  state: TemplateSignInPresentation;
  flow: TemplateCreator;
}) {
  const pending = () => (props.state.status === "pending" ? props.state : null);
  const [recovery, setRecovery] = createSignal<{ requestId: string; copied: boolean }>();
  const manual = () => recovery()?.requestId === pending()?.requestId && recovery();
  const status = () => {
    switch (props.state.status) {
      case "cancelled":
      case "denied":
        return "templatesDraft.signInCancelled";
      case "expired":
        return "templatesDraft.signInExpired";
      case "failed":
        return "templatesDraft.signInFailed";
      default:
        return "templatesDraft.signInExplanation";
    }
  };
  async function activate(button: HTMLButtonElement) {
    const request = pending();
    if (!request) {
      props.flow.startClawHubSignIn();
      return;
    }
    const current = () => button.isConnected && pending()?.requestId === request.requestId;
    // Both browser APIs need the click. Start copying before the tab takes focus,
    // but don't navigate away from OpenClaw until the code is on the clipboard.
    const copy = copyToClipboard(request.userCode, current);
    let tab: Window | null = null;
    let copied = false;
    try {
      tab = reserveExternalWindowForDeferredNavigation();
      copied = await copy;
      if (copied && current() && tab && !tab.closed) {
        tab.location.replace(request.verificationUrl);
        return;
      }
    } catch {
      // Browser policy may refuse a new window or its navigation.
    }
    tab?.close();
    if (current()) {
      setRecovery({ requestId: request.requestId, copied });
    }
  }
  return (
    <openclaw-chat-clawhub-card>
      <div class="card chat-clawhub-card template-creator__sign-in">
        <div class="chat-clawhub-card__listing">
          <span class="chat-clawhub-card__icon" aria-hidden="true">
            <img src={clawHubLogo} alt="" />
          </span>
          <span class="chat-clawhub-card__identity">
            <strong class="card-title chat-clawhub-card__name">
              {t("templatesDraft.clawHub")}
            </strong>
            <span
              class="chat-clawhub-card__status muted"
              role="status"
              data-approval-code={pending() ? "" : undefined}
            >
              {pending()?.userCode ?? t(status())}
            </span>
            <Show when={manual()}>
              {(failure) => (
                <span role="alert">
                  {t(
                    failure().copied
                      ? "templatesDraft.signInManualOpen"
                      : "templatesDraft.signInManualCopy",
                  )}
                </span>
              )}
            </Show>
          </span>
        </div>
        <div class="chat-clawhub-card__actions">
          <Show
            when={manual() && pending()}
            fallback={
              <button
                type="button"
                class="btn primary chat-clawhub-card__sign-in state-stack"
                disabled={props.state.status === "starting"}
                aria-busy={props.state.status === "starting" ? "true" : undefined}
                onClick={(event) => void activate(event.currentTarget)}
              >
                <span aria-hidden={pending() ? "true" : undefined}>
                  {t("templatesDraft.signIn")}
                </span>
                <span aria-hidden={pending() ? undefined : "true"}>
                  {t("templatesDraft.signInCopyOpen")}
                </span>
              </button>
            }
          >
            {(request) => (
              <>
                <button type="button" class="btn" onClick={() => props.flow.cancelClawHubSignIn()}>
                  {t("common.cancel")}
                </button>
                <a
                  class="btn primary"
                  href={request().verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("templatesDraft.signInOpen")}
                </a>
              </>
            )}
          </Show>
        </div>
      </div>
    </openclaw-chat-clawhub-card>
  );
}
