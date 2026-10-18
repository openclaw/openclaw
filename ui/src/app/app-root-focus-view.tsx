import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { FocusDashboardRouteState } from "./app-root-focus.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

type FocusDashboardProps = {
  route: FocusDashboardRouteState;
  snapshot: ApplicationGatewaySnapshot;
  sessions: ApplicationContext["sessions"];
  onClose: () => void;
  renderSplash: () => SolidJSX.Element;
  renderEscape: () => SolidJSX.Element;
  renderLoading: () => SolidJSX.Element;
};

export function FocusDashboard(props: FocusDashboardProps): SolidJSX.Element {
  const connected = () => props.snapshot.phase === "connected";
  const failure = createMemo(() => {
    const route = props.route;
    return route.kind === "error" || route.kind === "not-found" ? route : undefined;
  });
  const failureMessage = () => {
    const route = failure();
    return route?.kind === "error"
      ? t("dashboardDocument.loadFailed", { error: route.message })
      : t("dashboardDocument.notFound");
  };
  const ambiguous = createMemo(() => {
    const route = props.route;
    return route.kind === "ambiguous" ? route.data : undefined;
  });
  const session = createMemo(() => {
    const route = props.route;
    return route.kind === "session" ? route.data : undefined;
  });
  return (
    <Switch>
      <Match when={props.route.kind === "loading"}>{props.renderSplash()}</Match>
      <Match when={failure()}>
        {(route) => (
          <main class="board-document">
            <section
              class={
                route().kind === "error"
                  ? "board-document__state board-document__state--error stack"
                  : "board-document__state stack"
              }
              role={route().kind === "error" ? "alert" : "status"}
            >
              <span>{failureMessage()}</span>
              {props.renderEscape()}
            </section>
          </main>
        )}
      </Match>
      <Match when={ambiguous()}>
        {(data) => (
          <main class="board-document">
            <section class="card board-document__state">
              <h2>{t("chat.sessionRoute.chooseTitle")}</h2>
              <p>
                {data().candidates.length > 1
                  ? t("chat.sessionRoute.multipleMatches", { shortId: data().shortId })
                  : t("chat.sessionRoute.additionalMatches")}
              </p>
              <For each={data().candidates}>
                {(candidate) => (
                  <p>
                    <a href={candidate.href}>{candidate.displayName}</a>
                    <br />
                    <small>
                      {candidate.agentId} · {candidate.idPrefix}
                    </small>
                  </p>
                )}
              </For>
              <Show when={data().truncated}>
                <p>
                  <small>{t("chat.sessionRoute.additionalMatches")}</small>
                </p>
              </Show>
              {props.renderEscape()}
            </section>
          </main>
        )}
      </Match>
      <Match when={session()}>
        {(data) => (
          <>
            <openclaw-board-document
              prop:gatewaySnapshot={props.snapshot}
              prop:sessions={props.sessions}
              prop:sessionKey={data().sessionKey}
              prop:preparedSession={
                data().agentId ? { sessionKey: data().sessionKey, agentId: data().agentId } : null
              }
              prop:onDocumentClose={isNativeWebChromeHost() ? null : props.onClose}
            />
            <Show when={!connected() && props.snapshot.lastError === null}>
              {props.renderSplash()}
            </Show>
            <Show when={connected()}>{props.renderLoading()}</Show>
          </>
        )}
      </Match>
    </Switch>
  );
}
