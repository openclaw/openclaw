import { lazy, Show } from "solid-js";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { pathForClawHubSkill, pathForPluginCatalogEntry } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import "../../../styles/chat/clawhub-card.css";

export type ChatClawHubCardProps = {
  recommendation?: ClawHubRecommendation;
  agentId?: string;
};

const CardBody = lazy(() => import("./chat-clawhub-card-body.tsx"), {
  export: "ChatClawHubCardBody",
});

export function ChatClawHubCard(props: ChatClawHubCardProps) {
  const context = useApplication();
  function openListing(install = false) {
    const card = props.recommendation;
    if (!card) {
      return;
    }
    if (card.kind === "plugin") {
      context.navigate("plugins", {
        pathname: pathForPluginCatalogEntry(card.id, context.basePath),
        search: install ? "?action=install" : "",
      });
    } else {
      const search = props.agentId ? `?${new URLSearchParams({ agent: props.agentId })}` : "";
      context.navigate("skills", {
        pathname: pathForClawHubSkill(card.id, context.basePath),
        search,
      });
    }
  }
  return (
    <openclaw-chat-clawhub-card>
      <ChatLazyBoundary
        fallback={
          <Show when={props.recommendation}>
            {(card) => (
              <div class="card chat-clawhub-card" data-clawhub-id={card().id} aria-busy="true">
                <button
                  class="chat-clawhub-card__listing"
                  type="button"
                  onClick={() => openListing()}
                >
                  <span class="chat-clawhub-card__icon muted skeleton" aria-hidden="true" />
                  <span class="chat-clawhub-card__identity">
                    <span class="card-title chat-clawhub-card__name">
                      <span>{card().name}</span>{" "}
                      <Show when={card().official}>
                        <span
                          class="plugin-official-badge"
                          role="img"
                          aria-label={t("pluginsPage.official")}
                          title={t("pluginsPage.official")}
                        >
                          <Icon name="badgeCheck" />
                        </span>
                      </Show>
                    </span>
                    <span class="chat-clawhub-card__status muted" aria-live="polite">
                      <span class="chat-clawhub-card__status-skeleton">
                        <span class="btn__spinner" aria-hidden="true" />
                        <span>{t("common.loading")}</span>
                      </span>
                    </span>
                  </span>
                </button>
                <div class="chat-clawhub-card__actions" style={{ "min-width": "170px" }} />
              </div>
            )}
          </Show>
        }
      >
        <CardBody {...props} onOpenListing={openListing} />
      </ChatLazyBoundary>
    </openclaw-chat-clawhub-card>
  );
}
