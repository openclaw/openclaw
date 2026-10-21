import { For, Show } from "solid-js";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context-types.ts";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../../components/solid/identity-avatar.tsx";
import { i18n } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import type { agentRosterCards } from "../../lib/agents/roster-activity.ts";
import { registerAvatarGatewayReset } from "../../lib/identity-avatar-context.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { projectI18n, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { ReasonedDisabledControl } from "../plugins/reasoned-disabled-control.tsx";
import type { ClawCatalogEntry } from "./claws-catalog-client.ts";
import { ClawsExplore } from "./claws-explore.tsx";
import "../../styles/agents-home.css";

registerEnglishCatalog(registerAgentsHomeEnglish);

type AgentCard = Omit<ReturnType<typeof agentRosterCards>[number], "mainKey"> & {
  target: { href: string; options: ApplicationNavigationOptions };
};

type AgentsHomeProps = {
  canCreate: boolean;
  cards: AgentCard[];
  context: ApplicationContext;
  connected: boolean;
  loading: boolean;
  error: string | null;
  showExplore: boolean;
  onOpenCatalog: () => void;
  onSelectClaw: (entry: ClawCatalogEntry) => void;
  onRetry: () => void;
};

export function AgentsHomeView(props: AgentsHomeProps) {
  const locale = projectI18n(i18n);
  const title = () => {
    locale.revision();
    return titleForRoute("agents-home");
  };
  const avatarContext = projectSource(undefined, {
    read: () => undefined,
    subscribe: (_, notify) => registerAvatarGatewayReset(notify),
    equality: "revision",
  });
  const navigate = (event: MouseEvent, route: RouteId, options?: ApplicationNavigationOptions) => {
    if (shouldHandleNavigationClick(event)) {
      event.preventDefault();
      props.context.navigate(route, options);
    }
  };
  const manage = () => (
    <a
      class="btn"
      href={pathForRoute("agents", props.context.basePath)}
      onClick={(event) => navigate(event, "agents")}
    >
      {t("agentsHome.manage")}
    </a>
  );
  return (
    <>
      <HubPageHeader
        active="agents-home"
        wide
        docsUrl="https://docs.openclaw.ai/concepts/multi-agent"
        class="agents-home__header"
        actions={
          <>
            {props.showExplore ? (
              <button
                type="button"
                class="btn btn--icon"
                data-claws-open-catalog
                aria-label={t("clawsCatalog.search")}
                title={t("clawsCatalog.search")}
                aria-haspopup="dialog"
                disabled={!props.connected}
                onClick={props.onOpenCatalog}
              >
                <Icon name="search" />
              </button>
            ) : undefined}
            {manage()}
            <ReasonedDisabledControl
              reason={!props.canCreate ? t("custodian.accessRequired") : undefined}
            >
              <button
                class="btn primary"
                disabled={!props.canCreate}
                title={!props.canCreate ? t("custodian.accessRequired") : undefined}
                onClick={() => {
                  if (props.canCreate) {
                    props.context.navigate("custodian", { search: "?intent=new-agent" });
                  }
                }}
              >
                {t("agentsHome.create")}
              </button>
            </ReasonedDisabledControl>
          </>
        }
      />
      <section class="agents-home" aria-label={title()}>
        <Show when={!props.connected}>
          <div class="callout warn" role="status">
            {t("agentsHome.disconnected")}
          </div>
        </Show>
        <Show when={props.connected && props.error}>
          <div class="callout danger" role="alert">
            {props.error}
            <button class="btn btn--sm" onClick={() => props.onRetry()}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
        <Show when={props.connected && props.loading && props.cards.length === 0}>
          <div role="status" aria-label={t("agentsHome.loading")} class="agents-home__grid">
            <For each={[0, 1, 2, 3]}>
              {() => <div class="agents-home__skeleton" aria-hidden="true" />}
            </For>
          </div>
        </Show>
        <Show when={props.connected && !props.loading && !props.error && props.cards.length === 0}>
          <div class="agents-home__empty">
            <p>{t("agentsHome.empty")}</p>
            {manage()}
          </div>
        </Show>
        <div class="agents-home__grid">
          <For each={props.cards} keyed={(card) => card.id}>
            {(card) => (
              <a
                class="agents-home__card oc-card"
                data-agent-id={card().id}
                href={card().target.href}
                onClick={(event) => navigate(event, "chat", card().target.options)}
              >
                <div class="agents-home__identity">
                  <div class="agents-home__avatar" aria-hidden="true">
                    <AgentIdentityAvatar agent={(avatarContext.revision(), card())} />
                  </div>
                  <div class="agents-home__name">
                    <h2>{card().name}</h2>
                    <Show when={card().role}>
                      <p>{card().role}</p>
                    </Show>
                  </div>
                  <span class="btn btn--sm agents-home__open oc-action oc-action-secondary">
                    {t("agentsHome.openChat")}
                  </span>
                </div>
                <p class="agents-home__preview" title={card().preview ?? ""}>
                  {card().preview || t("agentsHome.noMessage")}
                </p>
              </a>
            )}
          </For>
        </div>
        {props.showExplore ? <ClawsExplore onSelect={props.onSelectClaw} /> : undefined}
      </section>
    </>
  );
}
