import { createGitHubActivityRenderer } from "@openclaw/github/control-ui-activity-api.js";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { ApplicationContext } from "../../app/context.ts";
import "../../components/link-reader-hovercard-registration.ts";
import { availableLinkPreviewReaders } from "../../app/link-reader-routing.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

registerActivityEnglish();

const renderGitHubActivity = createGitHubActivityRenderer({ t, icons });

class ActivitySessionGit extends OpenClawLightDomElement {
  @property({ attribute: false }) context!: ApplicationContext;
  @property() sessionKey = "";
  @property() agentId = "";

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      const store = sessionPullRequestsForGateway(gateway);
      const stopStore = store.subscribe(() => this.requestUpdate());
      const stopGateway = gateway.subscribe(() => this.requestUpdate());
      return () => {
        store.unwatch(this);
        stopStore();
        stopGateway();
      };
    },
  );

  override willUpdate() {
    if (!this.isConnected) {
      return;
    }
    sessionPullRequestsForGateway(this.context.gateway).watch(this, [this.sessionKey], {
      foreground: true,
    });
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    const gateway = this.context.gateway;
    const snapshot = sessionPullRequestsForGateway(gateway).get(this.sessionKey);
    if (!snapshot) {
      return nothing;
    }
    const presentation = renderGitHubActivity(snapshot, gateway.snapshot.phase === "connected");
    if (!presentation) {
      return nothing;
    }
    return html`<openclaw-link-reader-hovercard-provider
      .client=${gateway.snapshot.phase === "connected" ? gateway.snapshot.client : null}
      .readers=${availableLinkPreviewReaders(gateway.snapshot)}
      .agentId=${this.agentId}
      .previewSeeds=${presentation.previews}
    >
      ${presentation.content}
    </openclaw-link-reader-hovercard-provider>`;
  }
}

if (!customElements.get("openclaw-activity-session-git")) {
  customElements.define("openclaw-activity-session-git", ActivitySessionGit);
}
