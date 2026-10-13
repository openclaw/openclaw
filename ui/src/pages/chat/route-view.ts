import type { RouteMatch } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { renderPanelErrorState } from "../../components/lazy-view-error.ts";
import { t } from "../../i18n/index.ts";
import type { ChatRouteData } from "./route-loader.ts";

const CHAT_PAGE_OWNER_KEY = "chat-page";

function navigateTo(href: string) {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function renderChatRoute(data: unknown, _loaderPending = false, presented = true) {
  // SAFETY: This renderer receives only this route's colocated ChatRouteData loader result.
  const routeData = data as ChatRouteData | undefined;
  if (!routeData) {
    return nothing;
  }
  if (routeData.kind === "ambiguous") {
    return html`
      <section class="card">
        <h2>${t("chat.sessionRoute.chooseTitle")}</h2>
        <p>
          ${
            routeData.candidates.length > 1
              ? t("chat.sessionRoute.multipleMatches", { shortId: routeData.shortId })
              : t("chat.sessionRoute.additionalMatches")
          }
        </p>
        ${routeData.candidates.map(
          (candidate) => html`
            <p>
              <a href=${candidate.href}>${candidate.displayName}</a><br />
              <small>${candidate.agentId} · ${candidate.idPrefix}</small>
            </p>
          `,
        )}
        ${
          routeData.truncated && routeData.candidates.length > 1
            ? html`<p><small>${t("chat.sessionRoute.additionalMatches")}</small></p>`
            : null
        }
      </section>
    `;
  }
  if (routeData.kind === "route-error") {
    return html`<section class="card"><p role="alert">${routeData.message}</p></section>`;
  }
  if (routeData.kind === "missing-session") {
    return renderPanelErrorState({
      className: "session-route-not-found",
      role: "status",
      title: t("chat.sessionRoute.notFoundTitle"),
      subtitle: t("chat.sessionRoute.notFoundExplanation"),
      actions: html`
        <button
          class="btn primary"
          type="button"
          @click=${() => navigateTo(routeData.currentSessionHref)}
        >
          ${t("chat.sessionRoute.goToMain")}
        </button>
        <button class="btn" type="button" @click=${() => navigateTo(routeData.sessionsHref)}>
          ${t("chat.sessionRoute.viewSessions")}
        </button>
      `,
    });
  }
  return html`<openclaw-chat-page .data=${routeData} .presented=${presented}></openclaw-chat-page>`;
}

export function sessionRenderOwnerKey(
  match: Pick<RouteMatch, "data">,
  settled: Pick<RouteMatch, "data"> | undefined,
): string | undefined {
  // SAFETY: Both matches carry only this route's colocated ChatRouteData loader result.
  const data = (match.data ?? settled?.data) as ChatRouteData | undefined;
  return data?.kind === "session" ? CHAT_PAGE_OWNER_KEY : undefined;
}
