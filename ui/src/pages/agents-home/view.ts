import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { renderAgentIdentityAvatar } from "../../components/identity-avatar-view.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import type { agentRosterCards } from "../../lib/agents/roster-activity.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";
import type { ClawStatusRecord } from "./claws-catalog-client.ts";
import "../agents/claw-lifecycle-panel.ts";
import "./claws-explore.ts";
import "../../styles/agents-home.css";

registerAgentsHomeEnglish();

type AgentCard = Omit<ReturnType<typeof agentRosterCards>[number], "mainKey" | "unreadCount"> & {
  target: { href: string; options: ApplicationNavigationOptions };
};

type AgentsHomeProps = {
  cards: AgentCard[];
  context: ApplicationContext;
  connected: boolean;
  loading: boolean;
  error: string | null;
  canCreate: boolean;
  showExplore: boolean;
  onOpenCatalog: () => void;
  onSelectClaw: (entry: ClawCatalogEntry) => void;
  onRetry: () => void;
  unrepresentedClaws: ClawStatusRecord[];
  clawsStatusLoading: boolean;
  clawsStatusError: string | null;
  inspectedClawId: string | null;
  removePendingAgentId: string | null;
  removedClaw: boolean;
  onRetryClawsStatus: () => void;
  onInspectClaw: (agentId: string) => void;
  onClawRemoved: (agentId: string) => void;
  onClawRemovePendingChange: (agentId: string, pending: boolean) => void;
};

function labelClawStatus(status: string): string {
  const label = status.replaceAll(/[_-]/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function renderAgentsHome(props: AgentsHomeProps) {
  const { context } = props;
  const navigate = (event: MouseEvent, route: RouteId, options?: ApplicationNavigationOptions) => {
    if (shouldHandleNavigationClick(event)) {
      event.preventDefault();
      context.navigate(route, options);
    }
  };
  const manage = html`<a
    class="btn"
    href=${pathForRoute("agents", context.basePath)}
    @click=${(event: MouseEvent) => navigate(event, "agents")}
    >${t("agentsHome.manage")}</a
  >`;
  const searchClaws = props.showExplore
    ? html`<openclaw-tooltip .content=${t("clawsCatalog.search")}>
        <button
          type="button"
          class="btn btn--icon"
          data-claws-open-catalog
          aria-label=${t("clawsCatalog.search")}
          aria-haspopup="dialog"
          ?disabled=${!props.connected}
          @click=${props.onOpenCatalog}
        >
          ${icons.search}
        </button>
      </openclaw-tooltip>`
    : nothing;
  return html` <div class="agents-home__header">
      ${renderSettingsPageHeader({
        title: titleForRoute("agents-home"),
        subtitle: subtitleForRoute("agents-home"),
        actions: html`${searchClaws}${manage}
          <a
            class="btn primary"
            href=${props.canCreate ? `${pathForRoute("custodian", context.basePath)}?intent=new-agent` : pathForRoute("agents", context.basePath)}
            @click=${(event: MouseEvent) => navigate(event, props.canCreate ? "custodian" : "agents", props.canCreate ? { search: "?intent=new-agent" } : undefined)}
            >${t("agentsHome.create")}</a
          >`,
      })}
    </div>
    <section class="agents-home" aria-label=${titleForRoute("agents-home")}>
      ${!props.connected ? html`<div class="callout warn" role="status">${t("agentsHome.disconnected")}</div>` : nothing}
      ${
        props.connected && props.error
          ? html`<div class="callout danger" role="alert">
              ${props.error}
              <button class="btn btn--sm" @click=${props.onRetry}>${t("common.retry")}</button>
            </div>`
          : nothing
      }
      ${
        props.connected && props.loading && props.cards.length === 0
          ? html` <div
              role="status"
              aria-label=${t("agentsHome.loading")}
              class="agents-home__grid"
            >
              ${[0, 1, 2, 3].map(() => html`<div class="agents-home__skeleton" aria-hidden="true"></div>`)}
            </div>`
          : nothing
      }
      ${
        props.connected &&
        !props.loading &&
        !props.error &&
        !props.clawsStatusLoading &&
        props.cards.length === 0 &&
        props.unrepresentedClaws.length === 0 &&
        !props.removedClaw
          ? html` <div class="agents-home__empty">
              <p>${t("agentsHome.empty")}</p>
              ${manage}
            </div>`
          : nothing
      }
      <div class="agents-home__grid">
        ${repeat(
          props.cards,
          (card) => card.id,
          (card) => html` <a
            class="agents-home__card"
            data-agent-id=${card.id}
            href=${card.target.href}
            @click=${(event: MouseEvent) => navigate(event, "chat", card.target.options)}
          >
            <div class="agents-home__identity">
              <div class="agents-home__avatar" aria-hidden="true">
                ${renderAgentIdentityAvatar(card)}
              </div>
              <div class="agents-home__name">
                <h2>${card.name}</h2>
                ${card.role ? html`<p>${card.role}</p>` : nothing}
              </div>
            </div>
            ${card.model ? html`<span class="agents-home__model" title=${card.model}>${card.model}</span>` : nothing}
            <div class="agents-home__activity">
              ${
                card.activeNow
                  ? html`<span class="agents-home__working">${t("agentsHome.working")}</span>`
                  : card.lastActiveAt
                    ? t("agentsHome.lastActive", {
                        time: formatRelativeTimestamp(card.lastActiveAt),
                      })
                    : t("agentsHome.neverActive")
              }
            </div>
            <p class="agents-home__preview" title=${card.preview ?? ""}>
              ${card.preview || t("agentsHome.noMessage")}
            </p>
            <span class="btn primary agents-home__open">${t("agentsHome.openChat")}</span>
          </a>`,
        )}
      </div>
      ${
        props.clawsStatusLoading ||
        props.clawsStatusError ||
        props.unrepresentedClaws.length > 0 ||
        props.inspectedClawId ||
        props.removedClaw
          ? html`<section
              class="agents-home__attention"
              data-claws-attention
              aria-label=${t("agentsHome.clawsAttention")}
            >
              <div class="agents-home__attention-header">
                <h2>${t("agentsHome.clawsAttention")}</h2>
                <button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${!props.connected || props.clawsStatusLoading}
                  @click=${props.onRetryClawsStatus}
                >
                  ${t("clawsLifecycle.refresh")}
                </button>
              </div>
              ${
                props.removedClaw
                  ? html`<div class="callout success" role="status">
                      ${t("clawsLifecycle.removed")}
                    </div>`
                  : nothing
              }
              ${
                props.clawsStatusError
                  ? html`<div class="callout danger" role="alert">
                      ${props.clawsStatusError}
                      <button type="button" class="btn btn--sm" @click=${props.onRetryClawsStatus}>
                        ${t("common.retry")}
                      </button>
                    </div>`
                  : nothing
              }
              ${
                props.clawsStatusLoading && props.unrepresentedClaws.length === 0
                  ? html`<p role="status">${t("clawsLifecycle.loading")}</p>`
                  : nothing
              }
              <ul class="agents-home__attention-list">
                ${repeat(
                  props.unrepresentedClaws,
                  (record) => record.agentId,
                  (record) => html`<li data-claw-unrepresented=${record.agentId}>
                    <div class="agents-home__attention-identity">
                      <strong>${record.name}</strong>
                      <span
                        >${record.agentId} ·
                        ${t("clawsLifecycle.version", { version: record.version })} ·
                        ${t("clawsLifecycle.healthDetail", { agent: record.agentState, bootstrap: record.bootstrapState })}</span
                      >
                    </div>
                    <span class="claw-lifecycle__state" data-claw-status=${record.status}
                      >${labelClawStatus(record.status)}</span
                    >
                    <button
                      type="button"
                      class="btn btn--sm"
                      data-claw-inspect
                      aria-controls="agents-home-claw-inspector"
                      aria-expanded=${props.inspectedClawId === record.agentId}
                      title=${props.removePendingAgentId ? t("clawsLifecycle.checkBeforeRetry") : ""}
                      ?disabled=${!props.connected || Boolean(props.removePendingAgentId)}
                      @click=${() => props.onInspectClaw(record.agentId)}
                    >
                      ${
                        props.inspectedClawId === record.agentId
                          ? t("clawsLifecycle.close")
                          : t("agentsHome.inspectClaw")
                      }
                    </button>
                  </li>`,
                )}
              </ul>
              ${
                props.inspectedClawId
                  ? html`<div class="agents-home__claw-inspector" id="agents-home-claw-inspector">
                      <openclaw-agent-claw-panel
                        .agentId=${props.inspectedClawId}
                        .onRemoved=${props.onClawRemoved}
                        .onRemovePendingChange=${props.onClawRemovePendingChange}
                      ></openclaw-agent-claw-panel>
                    </div>`
                  : nothing
              }
            </section>`
          : nothing
      }
      ${
        props.showExplore
          ? html`<openclaw-claws-explore .onSelect=${props.onSelectClaw}></openclaw-claws-explore>`
          : nothing
      }
    </section>`;
}
