import { consume } from "@lit/context";
import { html } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderApps } from "./view.ts";

class AppsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  override render() {
    const body = renderApps({
      onNavigate: (routeId: RouteId) => this.context.navigate(routeId),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("apps")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-apps-page")) {
  customElements.define("openclaw-apps-page", AppsPage);
}
