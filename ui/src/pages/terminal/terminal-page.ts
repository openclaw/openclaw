import { consume } from "@lit/context";
import type { RouteLocation } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { renderPanelEmptyState } from "../../components/panel-empty-state.ts";
import "../../components/terminal/terminal-panel-registration.ts";
import { t } from "../../i18n/index.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolveTerminalRouteLocation } from "./route-location.ts";
import "./terminal-page.css";

class TerminalPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) location: RouteLocation | null = null;

  constructor() {
    super();
    new SubscriptionsController(this)
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
      )
      .watch(
        () => this.context?.config,
        (config, notify) => config.subscribe(notify),
      )
      .watch(
        () => this.context?.theme,
        (theme, notify) => theme.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (selection, notify) => selection.subscribe(notify),
      );
  }

  override render() {
    const context = this.context;
    const snapshot = context.gateway.snapshot;
    const available = isTerminalAvailable(
      snapshot,
      context.config.current.terminalEnabled ?? false,
    );
    const owner = context.agentSelection.state.selectedId ?? snapshot.assistantAgentId;
    const target = this.location
      ? resolveTerminalRouteLocation(this.location, context.basePath)
      : null;
    const key = target
      ? "sessionId" in target
        ? target.sessionId
        : buildCatalogSessionKey(target.catalog)
      : "";
    return keyed(
      key,
      html`<openclaw-terminal-panel
          ?hidden=${!available}
          embedded
          fullscreen
          .page=${true}
          .routeTarget=${target}
          .client=${snapshot.phase === "connected" ? snapshot.client : null}
          .available=${available}
          .agentId=${owner ? normalizeAgentId(owner) : null}
          .basePath=${context.basePath}
          .themeMode=${context.theme.resolvedMode}
        ></openclaw-terminal-panel>
        ${
          available
            ? nothing
            : renderPanelEmptyState({
                icon: icons.terminal,
                heading: t("terminal.title"),
                description: t("terminal.unavailable"),
                action: html`<button class="btn" @click=${() => context.navigate("new-session")}>
                  ${t("newSession.title")}
                </button>`,
              })
        }`,
    );
  }
}

customElements.define("openclaw-terminal-page", TerminalPage);
