import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { pathForPluginCatalogEntry } from "../../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { loadPluginDiscoveryDetail } from "../../../lib/plugins/index.ts";
import type { ClawHubSkillDetail } from "../../../lib/skills/index.ts";
import { loadSkillStatusReport } from "../../../lib/skills/status-report.ts";
import { GatewayPageController } from "../../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { CatalogIconController } from "../../plugins/catalog-icon-controller.ts";
import "../../../styles/chat/clawhub-card.css";

/** The transcript identifies the listing; its current catalog owner supplies status and actions. */
class ChatClawHubCard extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) recommendation?: ClawHubRecommendation;
  @property({ attribute: false }) agentId?: string;
  @state() private dismissed = false;
  @state() private iconUrls: Record<string, string> = {};

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.catalogIcons.reset(),
    onPageActivation: () => {
      if (this.gateway.connected && document.visibilityState === "visible") {
        void this.statusTask.run();
      }
    },
  });

  private readonly catalogIcons = new CatalogIconController({
    getFetchContext: () => ({
      resourceBasePath: this.context.resourceBasePath,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      auth: {
        hello: this.context.gateway.snapshot.hello,
        settings: { token: this.context.gateway.connection.token },
        password: this.context.gateway.connection.password,
      },
    }),
    isConnected: () => this.isConnected && this.gateway.connected,
    onUrlsChange: (urls) => {
      this.iconUrls = urls;
    },
  });

  private readonly statusTask = new Task(this, {
    args: () =>
      [
        this.gateway.connected ? this.gateway.client : null,
        this.agentId,
        this.gateway.epoch,
        this.recommendation?.id,
        this.recommendation?.kind,
        this.recommendation?.kind === "skill" ? this.recommendation.registry : undefined,
      ] as const,
    task: async ([client, agentId], { signal }) => {
      const card = this.recommendation;
      if (!client || !card) {
        return initialState;
      }
      if (card.kind === "plugin") {
        const { plugin } = await loadPluginDiscoveryDetail(client, card.id, signal);
        return {
          ...card,
          name: plugin.catalog.name,
          description: plugin.catalog.summary,
          iconUrl: plugin.catalog.imageUrl,
          official: plugin.catalog.official,
          installed: plugin.local.installed,
          canInstall: plugin.catalog.official && plugin.local.action === "install",
        };
      }
      if (!agentId) {
        throw new Error("Skill recommendations require an agent.");
      }
      const [detail, report] = await Promise.all([
        client.request<ClawHubSkillDetail>("skills.detail", { slug: card.id }, { signal }),
        loadSkillStatusReport(client, agentId),
      ]);
      if (!detail.skill || !report) {
        throw new Error("Skill details are unavailable.");
      }
      const installed = report.skills.some(
        ({ clawhub }) =>
          clawhub?.status === "linked" &&
          clawhub.valid &&
          !clawhub.requestedReference &&
          clawhub.registry === card.registry &&
          `@${clawhub.ownerHandle}/${clawhub.slug}` === card.id,
      );
      return {
        ...card,
        name: detail.skill.displayName,
        description: detail.skill.summary,
        official: detail.skill.isOfficial === true,
        installed,
        canInstall: detail.skill.isOfficial === true && !installed,
      };
    },
    onComplete: (card) => this.catalogIcons.sync([], card.iconUrl ? [card.iconUrl] : []),
  });

  override disconnectedCallback(): void {
    this.catalogIcons.reset();
    super.disconnectedCallback();
  }

  private openListing(install = false): void {
    const card = this.recommendation;
    if (!card) {
      return;
    }
    if (card.kind === "plugin") {
      this.context.navigate("plugins", {
        pathname: pathForPluginCatalogEntry(card.id, this.context.basePath),
        search: install ? "?action=install" : "",
      });
    } else {
      const search = new URLSearchParams({ clawhub: card.id });
      if (this.agentId) {
        search.set("agent", this.agentId);
      }
      this.context.navigate("skills", { search: `?${search}` });
    }
  }

  override render() {
    if (!this.recommendation || this.dismissed) {
      return nothing;
    }
    const ready = this.statusTask.status === TaskStatus.COMPLETE;
    const card = ready ? this.statusTask.value : this.recommendation;
    if (!card) {
      return nothing;
    }
    const failed = this.statusTask.status === TaskStatus.ERROR;
    const icon = card.iconUrl ? this.iconUrls[card.iconUrl] : undefined;
    return html`
      <div class="chat-clawhub-card" data-clawhub-id=${card.id}>
        <button class="chat-clawhub-card__listing" type="button" @click=${() => this.openListing()}>
          <span class="chat-clawhub-card__icon" aria-hidden="true">
            ${icon ? html`<img src=${icon} alt="" />` : icons.plug}
          </span>
          <span class="chat-clawhub-card__identity">
            <span class="chat-clawhub-card__name"
              >${card.name}
              ${card.official ? html`<span class="chat-clawhub-card__official" aria-label=${t("pluginsPage.official")}>${icons.badgeCheck}</span>` : nothing}
            </span>
            ${card.description ? html`<span class="chat-clawhub-card__description">${card.description}</span>` : nothing}
          </span>
        </button>
        <div class="chat-clawhub-card__actions" aria-live="polite">
          ${
            ready && card.installed
              ? html`<span class="chat-clawhub-card__installed"
                  >${icons.check}<span>${t("pluginsPage.installed")}</span></span
                >`
              : ready
                ? html`<button
                      type="button"
                      class="chat-clawhub-card__dismiss"
                      @click=${() => {
                        this.dismissed = true;
                      }}
                    >
                      ${t("chat.clawhub.notNow")}
                    </button>
                    <button
                      type="button"
                      class="chat-clawhub-card__install"
                      @click=${() => this.openListing(this.statusTask.value?.canInstall === true)}
                    >
                      ${this.statusTask.value?.canInstall ? t("pluginsPage.install") : t("chat.clawhub.viewDetails")}
                    </button>`
                : failed
                  ? html`<button
                      type="button"
                      class="chat-clawhub-card__dismiss"
                      @click=${() => this.statusTask.run()}
                    >
                      ${t("chat.clawhub.retryStatus")}
                    </button>`
                  : html`<span class="chat-clawhub-card__checking"
                      >${t("chat.clawhub.checking")}</span
                    >`
          }
        </div>
      </div>
    `;
  }
}

customElements.define("openclaw-chat-clawhub-card", ChatClawHubCard);
