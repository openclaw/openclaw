import { createSignal, onSettled, Show } from "solid-js";
import { createBrowserPairSession, type BrowserPairState } from "../lib/browser-pair.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ConnectCommand } from "./solid/connect-command.tsx";
import { Icon } from "./solid/icon.tsx";

/** Owned by the gate so a waiting attempt survives its form and status layouts. */
export function createLoginGateBrowserPair(params: {
  basePath: () => string;
  gatewayUrl: () => string;
  onPaired: (bootstrapToken: string, gatewayUrl: string) => void;
}) {
  const [state, setState] = createSignal<BrowserPairState>({ kind: "idle" });
  const session = createBrowserPairSession({
    get basePath() {
      return params.basePath();
    },
    onState: setState,
    onApproved: params.onPaired,
  });
  onSettled(() => session.dispose);
  return {
    state,
    start: () => session.start(params.gatewayUrl()),
    cancel: session.cancel,
    retireUnlessTarget: session.retireUnlessTarget,
  };
}

export type LoginGateBrowserPairModel = ReturnType<typeof createLoginGateBrowserPair>;

/** Card 1 offers pairing as a second way in without crowding the sign-in form. */
export function LoginGateBrowserPairLink(props: { onOpen: () => void }) {
  return (
    <button
      type="button"
      class="btn btn--ghost login-gate__browser-pair-start"
      onClick={() => props.onOpen()}
    >
      {t("login.browserPair.open")} <Icon name="chevronRight" />
    </button>
  );
}

/** Card 2: one way in, so the sign-in form and its troubleshooting stay on card 1. */
export function LoginGateBrowserPairCard(props: {
  pair: LoginGateBrowserPairModel;
  onBack: () => void;
}) {
  const waiting = () => {
    const current = props.pair.state();
    return current.kind === "waiting" ? current : null;
  };
  const failure = () => {
    const current = props.pair.state();
    return current.kind === "failed" ? current : null;
  };
  return (
    <section class="login-gate__body" aria-live="polite">
      <div>
        <button
          type="button"
          class="btn btn--ghost login-gate__browser-pair-back"
          onClick={() => {
            props.pair.cancel();
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
      <Show
        when={waiting()}
        fallback={
          <>
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
              disabled={props.pair.state().kind === "starting"}
              onClick={() => void props.pair.start()}
            >
              {t(failure() ? "common.retry" : "login.browserPair.getCode")}
            </button>
          </>
        }
      >
        {(request) => (
          <>
            <div class="login-gate__hero">
              <span class="login-gate__hero-label">{t("login.runOnHost")}</span>
              <ConnectCommand command={`openclaw pair ${request().code}`} variant="hero" />
            </div>
            <p class="login-gate__lede login-gate__browser-pair-code">
              {t("login.browserPair.identity", {
                code: request().code,
                id: request().browserId,
              })}
            </p>
            <p class="login-gate__lede">
              <span class="session-run-spinner" aria-hidden="true" />
              {t("login.browserPair.waiting")}
            </p>
            <button type="button" class="btn" onClick={() => props.pair.cancel()}>
              {t("common.cancel")}
            </button>
          </>
        )}
      </Show>
    </section>
  );
}
