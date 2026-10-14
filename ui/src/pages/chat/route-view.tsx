import type { RouteMatch } from "@openclaw/uirouter";
import { For, Match, Switch } from "solid-js";
import type { SolidRouteProps } from "../../app-route-types.ts";
import { PanelErrorState } from "../../components/solid/lazy-view-error.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { ChatPageView } from "./chat-page.ts";
import type { ChatRouteData } from "./route-loader.ts";

function navigateTo(href: string) {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function ChatRouteView(props: SolidRouteProps<ChatRouteData>) {
  const ambiguous = () => (props.data?.kind === "ambiguous" ? props.data : undefined);
  const error = () => (props.data?.kind === "route-error" ? props.data : undefined);
  const missing = () => (props.data?.kind === "missing-session" ? props.data : undefined);
  const session = () => (props.data?.kind === "session" ? props.data : undefined);
  return (
    <Switch>
      <Match when={ambiguous()}>
        {(data) => (
          <section class="card">
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
            {data().truncated && data().candidates.length > 1 ? (
              <p>
                <small>{t("chat.sessionRoute.additionalMatches")}</small>
              </p>
            ) : undefined}
          </section>
        )}
      </Match>
      <Match when={error()}>
        {(data) => (
          <section class="card">
            <p role="alert">{data().message}</p>
          </section>
        )}
      </Match>
      <Match when={missing()}>
        {(data) => (
          <PanelErrorState
            class="session-route-not-found"
            role="status"
            title={t("chat.sessionRoute.notFoundTitle")}
            subtitle={t("chat.sessionRoute.notFoundExplanation")}
            actions={
              <>
                <button
                  class="btn primary"
                  type="button"
                  onClick={() => navigateTo(data().currentSessionHref)}
                >
                  {t("chat.sessionRoute.goToMain")}
                </button>
                <button class="btn" type="button" onClick={() => navigateTo(data().sessionsHref)}>
                  {t("chat.sessionRoute.viewSessions")}
                </button>
              </>
            }
          />
        )}
      </Match>
      <Match when={session()}>
        {(data) => <ChatPageView data={data()} presented={props.presented} />}
      </Match>
    </Switch>
  );
}

export function sessionRenderOwnerKey(
  match: Pick<RouteMatch, "data">,
  settled: Pick<RouteMatch, "data"> | undefined,
): string | undefined {
  // SAFETY: Both matches carry only this route's colocated ChatRouteData loader result.
  const data = (match.data ?? settled?.data) as ChatRouteData | undefined;
  return data?.kind === "session" ? "chat-page" : undefined;
}
