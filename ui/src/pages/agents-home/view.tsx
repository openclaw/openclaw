import { For, Show } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context-types.ts";
import { renderAgentIdentityAvatar } from "../../components/identity-avatar-view.ts";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { i18n } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import type { agentRosterCards } from "../../lib/agents/roster-activity.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { registerAvatarGatewayReset } from "../../lib/identity-avatar-context.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { projectI18n, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import "../../styles/agents-home.css";

registerEnglishCatalog(registerAgentsHomeEnglish);

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
  onRetry: () => void;
};

export function AgentsHomeView(props: AgentsHomeProps) {
  const locale = projectI18n(i18n);
  const title = () => {
    locale.revision();
    return titleForRoute("agents-home");
  };
  const subtitle = () => {
    locale.revision();
    return subtitleForRoute("agents-home");
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
      <div class="agents-home__header">
        <SettingsPageHeader
          title={title()}
          subtitle={subtitle()}
          actions={
            <>
              {manage()}
              <a
                class="btn primary"
                href={
                  props.canCreate
                    ? `${pathForRoute("custodian", props.context.basePath)}?intent=new-agent`
                    : pathForRoute("agents", props.context.basePath)
                }
                onClick={(event) =>
                  navigate(
                    event,
                    props.canCreate ? "custodian" : "agents",
                    props.canCreate ? { search: "?intent=new-agent" } : undefined,
                  )
                }
              >
                {t("agentsHome.create")}
              </a>
            </>
          }
        />
      </div>
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
                class="agents-home__card"
                data-agent-id={card().id}
                href={card().target.href}
                onClick={(event) => navigate(event, "chat", card().target.options)}
              >
                <div class="agents-home__identity">
                  <div class="agents-home__avatar" aria-hidden="true">
                    <LitContent
                      render={() => {
                        avatarContext.revision();
                        return renderAgentIdentityAvatar(card());
                      }}
                    />
                  </div>
                  <div class="agents-home__name">
                    <h2>{card().name}</h2>
                    <Show when={card().role}>
                      <p>{card().role}</p>
                    </Show>
                  </div>
                </div>
                <Show when={card().model}>
                  <span class="agents-home__model" title={card().model}>
                    {card().model}
                  </span>
                </Show>
                <div class="agents-home__activity">
                  <Show
                    when={card().activeNow}
                    fallback={
                      card().lastActiveAt
                        ? t("agentsHome.lastActive", {
                            time: formatRelativeTimestamp(card().lastActiveAt),
                          })
                        : t("agentsHome.neverActive")
                    }
                  >
                    <span class="agents-home__working">{t("agentsHome.working")}</span>
                  </Show>
                </div>
                <p class="agents-home__preview" title={card().preview ?? ""}>
                  {card().preview || t("agentsHome.noMessage")}
                </p>
                <span class="btn primary agents-home__open">{t("agentsHome.openChat")}</span>
              </a>
            )}
          </For>
        </div>
      </section>
    </>
  );
}
