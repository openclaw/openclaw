import { createSignal, onSettled, Show } from "solid-js";
import { createBrowserPairSession, type BrowserPairState } from "../lib/browser-pair.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ConnectCommand } from "./solid/connect-command.tsx";

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

export function LoginGateBrowserPair(props: { pair: LoginGateBrowserPairModel }) {
  const waiting = () => {
    const current = props.pair.state();
    return current.kind === "waiting" ? current : null;
  };
  const failure = () => {
    const current = props.pair.state();
    return current.kind === "failed" ? current : null;
  };
  return (
    <section class="stack" aria-live="polite">
      <Show
        when={waiting()}
        fallback={
          <>
            <Show when={failure()}>
              {(failed) => (
                <p class="login-gate__lede" role="status">
                  {t(`login.browserPair.failure.${failed().reason}`)}
                </p>
              )}
            </Show>
            <button
              type="button"
              class="btn login-gate__browser-pair-start"
              disabled={props.pair.state().kind === "starting"}
              onClick={() => void props.pair.start()}
            >
              {t("login.browserPair.action")}
            </button>
          </>
        }
      >
        {(request) => (
          <>
            <p class="login-gate__heading mono login-gate__browser-pair-code">{request().code}</p>
            <div class="login-gate__hero">
              <span class="login-gate__hero-label">{t("login.runOnHost")}</span>
              <ConnectCommand command={`openclaw pair ${request().code}`} variant="hero" />
            </div>
            <p class="login-gate__lede">
              {t("login.browserPair.browserId", { id: request().browserId })}
            </p>
            <p class="login-gate__lede">
              <span class="session-run-spinner" aria-hidden="true" />
              {t("login.browserPair.waiting")}
            </p>
            <button type="button" class="btn btn--ghost" onClick={() => props.pair.cancel()}>
              {t("common.cancel")}
            </button>
          </>
        )}
      </Show>
    </section>
  );
}
