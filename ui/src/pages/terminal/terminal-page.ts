import { consume } from "@lit/context";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/terminal/terminal-panel-registration.ts";
import type { TerminalRouteTarget } from "../../components/terminal/terminal-panel-session-types.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "./terminal-page.css";

class TerminalPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) target: TerminalRouteTarget = null;

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
    const owner = context.agentSelection.state.selectedId ?? snapshot.assistantAgentId;
    const target = this.target;
    const key = target
      ? "sessionId" in target
        ? target.sessionId
        : buildCatalogSessionKey(target.catalog)
      : "";
    return keyed(
      key,
      html`<openclaw-terminal-panel
        embedded
        fullscreen
        .page=${true}
        .routeTarget=${target}
        .client=${snapshot.phase === "connected" ? snapshot.client : null}
        .available=${isTerminalAvailable(snapshot, context.config.current.terminalEnabled ?? false)}
        .agentId=${owner ? normalizeAgentId(owner) : null}
        .basePath=${context.basePath}
        .themeMode=${context.theme.resolvedMode}
      ></openclaw-terminal-panel>`,
    );
  }
}

customElements.define("openclaw-terminal-page", TerminalPage);
