import { lazy, Show } from "solid-js";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { pathForPluginCatalogEntry } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import "../../../styles/chat/clawhub-card.css";

export type ChatClawHubCardProps = {
  recommendation?: ClawHubRecommendation;
  agentId?: string;
};

const CardBody = lazy(() =>
  import("./chat-clawhub-card-body.tsx").then(({ ChatClawHubCardBody }) => ({
    default: ChatClawHubCardBody,
  })),
);

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
      const search = new URLSearchParams({ clawhub: card.id });
      if (props.agentId) {
        search.set("agent", props.agentId);
      }
      context.navigate("skills", { search: `?${search}` });
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
                  <span class="chat-clawhub-card__icon skeleton" aria-hidden="true" />
                  <span class="chat-clawhub-card__identity">
                    <span class="card-title chat-clawhub-card__name">
                      <span>{card().name}</span>{" "}
                      <span
                        class="plugin-official-badge"
                        role="img"
                        aria-label={t("pluginsPage.official")}
                        title={t("pluginsPage.official")}
                      >
                        <Icon name="badgeCheck" />
                      </span>
                    </span>
                    <Show when={card().description}>
                      {(description) => <span class="card-sub">{description()}</span>}
                    </Show>
                  </span>
                </button>
                <div class="chat-clawhub-card__actions" aria-live="polite">
                  <span class="skeleton chat-clawhub-card__status-skeleton" aria-hidden="true" />
                  <span class="sr-only">{t("common.loading")}</span>
                </div>
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
