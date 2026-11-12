// Loaded when the person opens pairing, so the boot sign-in gate carries only its link.
import { createSignal, onSettled, Show } from "solid-js";
import { createBrowserPairSession, type BrowserPairState } from "../lib/browser-pair.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { LoginGateElement } from "./login-gate-solid.tsx";
import { ConnectCommand } from "./solid/connect-command.tsx";
import { Icon } from "./solid/icon.tsx";

/**
 * Card 2: one way in, so the sign-in form and its troubleshooting stay on card 1.
 * Leaving retires local polling; Cancel explicitly asks the Gateway to withdraw it.
 */
export function LoginGateBrowserPairCard(props: {
  host: LoginGateElement;
  basePath: string;
  gatewayUrl: string;
  onPaired: (gatewayUrl: string) => void;
  onBack: () => void;
}) {
  const [state, setState] = createSignal<BrowserPairState>({ kind: "idle" });
  const session = createBrowserPairSession({
    get basePath() {
      return props.basePath;
    },
    onState: setState,
    onApproved: (gatewayUrl) => props.onPaired(gatewayUrl),
  });
  onSettled(() => {
    // An approval is only valid for its issuer: a new target ends the attempt before Solid commits it.
    const stopChange = listen(props.host, "login-gate-props-change", () =>
      session.retireUnlessTarget(props.host.props?.gatewayUrl),
    );
    return () => {
      stopChange();
      session.dispose();
    };
  });
  const waiting = () => {
    const current = state();
    return "code" in current ? current : null;
  };
  const failure = () => {
    const current = state();
    return current.kind === "failed" ? current : null;
  };
  return (
    <section class="login-gate__body" aria-live="polite">
      <div>
        <button
          type="button"
          class="btn btn--ghost login-gate__browser-pair-back"
          onClick={() => {
            session.dispose();
            props.onBack();
          }}
        >
          <Icon name="chevronLeft" /> {t("login.browserPair.back")}
        </button>
      </div>
      <div class="login-gate__status-text">
        <h1 class="login-gate__heading">{t("login.browserPair.action")}</h1>
        <p class="login-gate__lede">{t("login.browserPair.intro")}</p>
      </div>
      <Show when={state().kind === "cancelled"}>
        <p role="status">{t("login.browserPair.cancelled")}</p>
      </Show>
      <Show
        when={waiting()}
        fallback={
          <>
            <Show when={state().kind === "starting"}>
              <p class="login-gate__lede" role="status">
                {t("login.browserPair.starting")}
              </p>
            </Show>
            <Show when={failure()}>
              {(failed) => (
                <p class="login-gate__failure-summary" role="status">
                  {t(`login.browserPair.failure.${failed().reason}`)}
                </p>
              )}
            </Show>
            <button
              type="button"
              class="btn primary login-gate__connect login-gate__browser-pair-get"
              disabled={state().kind === "starting"}
              onClick={() => void session.start(props.gatewayUrl)}
            >
              {t(failure() ? "common.retry" : "login.browserPair.getCode")}
            </button>
          </>
        }
      >
        {(request) => (
          <>
            <div class="login-gate__hero">
              <span class="login-gate__hero-label">{t("login.browserPair.runOnGatewayHost")}</span>
              <ConnectCommand command={`openclaw pair ${request().code}`} variant="hero" />
            </div>
            <p class="login-gate__lede login-gate__browser-pair-code">
              {t("login.browserPair.identity", {
                code: request().code,
                id: request().browserId,
              })}
            </p>
            <p class="login-gate__lede" role="status">
              <Show
                when={request().kind !== "cancelFailed" && request().kind !== "alreadyApproved"}
              >
                <span class="session-run-spinner" aria-hidden="true" />
              </Show>
              {t(
                request().kind === "waiting"
                  ? "login.browserPair.waiting"
                  : request().kind === "reconnecting"
                    ? "login.browserPair.reconnecting"
                    : request().kind === "cancelling"
                      ? "login.browserPair.cancelling"
                      : request().kind === "cancelFailed"
                        ? "login.browserPair.cancelFailed"
                        : "login.browserPair.alreadyApproved",
              )}
            </p>
            <Show
              when={request().kind === "alreadyApproved"}
              fallback={
                <button
                  type="button"
                  class="btn"
                  disabled={request().kind === "cancelling"}
                  onClick={() => void session.cancel()}
                >
                  {t(
                    request().kind === "cancelFailed"
                      ? "login.browserPair.retryCancel"
                      : "common.cancel",
                  )}
                </button>
              }
            >
              <button
                type="button"
                class="btn primary"
                onClick={() => session.continueAfterApproval()}
              >
                {t("login.browserPair.continue")}
              </button>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
