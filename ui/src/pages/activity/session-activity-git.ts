import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { ControlUiSessionPullRequest } from "../../../../src/gateway/control-ui-contract.js";
import type { ApplicationContext } from "../../app/context.ts";
import "../../components/github-link-hovercard-registration.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { sessionPullRequestsForGateway } from "../../lib/session-pull-requests.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

registerActivityEnglish();

function renderDiff(item: { additions?: number; deletions?: number }) {
  return html`${
    item.additions === undefined
      ? nothing
      : html`<span class="activity-feed__additions">+${item.additions.toLocaleString()}</span>`
  }${
    item.deletions === undefined
      ? nothing
      : html`<span class="activity-feed__deletions">−${item.deletions.toLocaleString()}</span>`
  }`;
}

function renderPullRequest(pr: ControlUiSessionPullRequest) {
  const icon = {
    open: icons.gitPullRequest,
    draft: icons.gitPullRequestDraft,
    merged: icons.gitMerge,
    closed: icons.gitPullRequestClosed,
  }[pr.state];
  return html`<a
    class="activity-feed__pr"
    data-state=${pr.state}
    href=${pr.url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label=${t("activity.git.pullRequest", {
      repository: `${pr.owner}/${pr.repo}`,
      number: String(pr.number),
      title: pr.title,
      state: t(`activity.git.${pr.state}`),
    })}
  >
    <span class="activity-feed__git-icon" aria-hidden="true">${icon}</span>
    <span class="activity-feed__git-label">${pr.repo}#${pr.number}</span>
    ${renderDiff(pr)}
  </a>`;
}

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
    const branch = snapshot.pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")
      ? undefined
      : snapshot.branch;
    if (!branch && snapshot.pullRequests.length === 0) {
      return nothing;
    }
    const stale = snapshot.status !== "ready" || gateway.snapshot.phase !== "connected";
    return html`<openclaw-github-link-hovercard-provider
      .client=${gateway.snapshot.client}
      .agentId=${this.agentId}
    >
      <div class="activity-feed__git">
        ${
          branch
            ? html`<span
                class="activity-feed__branch"
                title=${t("activity.git.branchDiff", { branch: branch.branch })}
              >
                <span class="activity-feed__git-icon" aria-hidden="true">${icons.gitBranch}</span>
                <span class="activity-feed__git-label">${branch.branch}</span>
                ${renderDiff(branch)}
              </span>`
            : nothing
        }
        ${snapshot.pullRequests.map(renderPullRequest)}
        ${
          stale
            ? html`<span
                class="activity-feed__git-stale"
                role="img"
                aria-label=${t("activity.git.stale")}
                title=${t("activity.git.stale")}
                >${icons.alertTriangle}</span
              >`
            : nothing
        }
      </div>
    </openclaw-github-link-hovercard-provider>`;
  }
}

if (!customElements.get("openclaw-activity-session-git")) {
  customElements.define("openclaw-activity-session-git", ActivitySessionGit);
}
