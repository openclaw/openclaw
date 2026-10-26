import type { RouteMatch } from "@openclaw/uirouter";
import { For, Match, Switch } from "solid-js";
import { HomeSessionUnavailable } from "../../components/home-session-unavailable.tsx";
import { PanelErrorState } from "../../components/solid/lazy-view-error.tsx";
import { registerSessionNavigationEnglish } from "../../i18n/locales/en-session-navigation.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "./chat-page.tsx";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import type { ChatPageProps } from "./chat-page-types.ts";
import type { ChatRouteData } from "./route-loader.ts";

registerEnglishCatalog(registerSessionNavigationEnglish);

const CHAT_PAGE_OWNER_KEY = "chat-page";

function navigateTo(href: string) {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function ChatRouteView(props: { data?: unknown; presented?: boolean }) {
  // SAFETY: This renderer receives only this route's colocated ChatRouteData loader result.
  const routeData = () => props.data as ChatRouteData | undefined;
  const ambiguous = () => {
    const value = routeData();
    return value?.kind === "ambiguous" ? value : undefined;
  };
  const error = () => {
    const value = routeData();
    return value?.kind === "route-error" ? value : undefined;
  };
  const missing = () => {
    const value = routeData();
    return value?.kind === "missing-session" ? value : undefined;
  };
  const unavailableHome = () => {
    const value = routeData();
    return value?.kind === "unavailable-home" ? value : undefined;
  };
  const session = () => {
    const value = routeData();
    return value?.kind === "session" ? value : undefined;
  };
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
      <Match when={unavailableHome()}>
        {(data) => <HomeSessionUnavailable agentId={data().agentId} />}
      </Match>
      <Match when={session()}>
        {(data) => (
          <openclaw-chat-page prop:data={data()} prop:presented={props.presented !== false} />
        )}
      </Match>
    </Switch>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-page": HTMLAttributes<HTMLElement> &
        ElementProperties<Pick<ChatPageProps, "data" | "presented">>;
    }
  }
}

export function sessionRenderOwnerKey(
  match: Pick<RouteMatch, "data">,
  settled: Pick<RouteMatch, "data"> | undefined,
): string | undefined {
  // SAFETY: Both matches carry only this route's colocated ChatRouteData loader result.
  const data = (match.data ?? settled?.data) as ChatRouteData | undefined;
  return data?.kind === "session" ? CHAT_PAGE_OWNER_KEY : undefined;
}
