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
import { renderPluginOfficialBadge } from "../../plugins/plugin-card.ts";
import { PluginIconController } from "../../plugins/plugin-icon-controller.ts";
import { resolvePluginCatalogIconUrl } from "../../plugins/presentation.ts";
import "../../../styles/chat/clawhub-card.css";

/** The transcript identifies the listing; its current catalog owner supplies status and actions. */
class ChatClawHubCard extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) recommendation?: ClawHubRecommendation;
  @property({ attribute: false }) agentId?: string;
  @state() private dismissed = false;
  @state() private iconUrls: Record<string, string> = {};
  @state() private pluginIconUrls: Record<string, string> = {};
  @state() private loadedImage?: string;
  @state() private failedImages: ReadonlySet<string> = new Set();
  private iconPluginId?: string;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetIcons(),
    onPageActivation: () => {
      if (this.gateway.connected && document.visibilityState === "visible") {
        void this.statusTask.run();
      }
    },
  });

  private get iconFetchContext() {
    return {
      resourceBasePath: this.context.resourceBasePath,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      auth: {
        hello: this.context.gateway.snapshot.hello,
        settings: { token: this.context.gateway.connection.token },
        password: this.context.gateway.connection.password,
      },
    };
  }

  private readonly catalogIcons = new CatalogIconController({
    getFetchContext: () => this.iconFetchContext,
    isConnected: () => this.isConnected && this.gateway.connected,
    onUrlsChange: (urls) => {
      this.iconUrls = urls;
    },
    onLoadingChange: () => this.requestUpdate(),
  });

  private readonly pluginIcons = new PluginIconController({
    getFetchContext: () => this.iconFetchContext,
    isConnected: () => this.isConnected && this.gateway.connected,
    onUrlsChange: (urls) => {
      this.pluginIconUrls = urls;
    },
    onLoadingChange: () => this.requestUpdate(),
  });

  private resetIcons(): void {
    this.catalogIcons.reset();
    this.pluginIcons.reset();
    this.loadedImage = undefined;
    this.failedImages = new Set();
  }

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
          pluginId: plugin.local.pluginId,
          packageName: plugin.catalog.packageName,
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
        pluginId: undefined,
        packageName: undefined,
        description: detail.skill.summary,
        official: detail.skill.isOfficial === true,
        installed,
        canInstall: detail.skill.isOfficial === true && !installed,
      };
    },
    onComplete: (card) => {
      if (card.pluginId !== this.iconPluginId) {
        this.pluginIcons.reset();
        this.iconPluginId = card.pluginId;
      }
      if (card.pluginId) {
        this.pluginIcons.load(card.pluginId);
      }
      this.catalogIcons.sync([], card.iconUrl ? [card.iconUrl] : []);
    },
  });

  override disconnectedCallback(): void {
    this.resetIcons();
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
    const resolved = ready ? this.statusTask.value : undefined;
    const icon = resolvePluginCatalogIconUrl(
      { pluginId: resolved?.pluginId, packageName: resolved?.packageName, imageUrl: card.iconUrl },
      { pluginIconUrls: this.pluginIconUrls, iconUrls: this.iconUrls },
      this.failedImages,
    );
    // A decoded source stays visible while lower-priority artwork is still fetching.
    const iconPending =
      (!ready && !failed) ||
      (icon
        ? this.loadedImage !== icon
        : Boolean(resolved?.pluginId && this.pluginIcons.isLoading(resolved.pluginId)) ||
          Boolean(card.iconUrl && this.catalogIcons.isLoading(card.iconUrl)));
    const statusPending = !ready && !failed;
    return html`
      <div
        class="card chat-clawhub-card"
        data-clawhub-id=${card.id}
        aria-busy=${statusPending || iconPending}
      >
        <button class="chat-clawhub-card__listing" type="button" @click=${() => this.openListing()}>
          <span class="chat-clawhub-card__icon ${iconPending ? "skeleton" : ""}" aria-hidden="true">
            ${
              icon
                ? html`<img
                    src=${icon}
                    alt=""
                    ?hidden=${iconPending}
                    @load=${() => {
                      this.loadedImage = icon;
                    }}
                    @error=${() => {
                      this.failedImages = new Set([...this.failedImages, icon]);
                    }}
                  />`
                : iconPending
                  ? nothing
                  : icons.plug
            }
          </span>
          <span class="chat-clawhub-card__identity">
            <span class="card-title chat-clawhub-card__name"
              >${card.name} ${card.official ? renderPluginOfficialBadge() : nothing}
            </span>
            ${card.description ? html`<span class="card-sub">${card.description}</span>` : nothing}
          </span>
        </button>
        <div class="chat-clawhub-card__actions" aria-live="polite">
          ${
            ready && card.installed
              ? html`<span class="chip chip-ok chat-clawhub-card__installed"
                  >${icons.check}<span>${t("pluginsPage.installed")}</span></span
                >`
              : ready
                ? html`<button
                      type="button"
                      class="btn chat-clawhub-card__dismiss"
                      @click=${() => {
                        this.dismissed = true;
                      }}
                    >
                      ${t("common.dismiss")}
                    </button>
                    <button
                      type="button"
                      class="btn primary chat-clawhub-card__install"
                      @click=${() => this.openListing(this.statusTask.value?.canInstall === true)}
                    >
                      ${this.statusTask.value?.canInstall ? t("pluginsPage.install") : t("chat.clawhub.viewDetails")}
                    </button>`
                : failed
                  ? html`<button
                      type="button"
                      class="btn chat-clawhub-card__dismiss"
                      @click=${() => this.statusTask.run()}
                    >
                      ${t("chat.clawhub.retryStatus")}
                    </button>`
                  : html`<span
                        class="skeleton chat-clawhub-card__status-skeleton"
                        aria-hidden="true"
                      ></span>
                      <span class="sr-only">${t("common.loading")}</span>`
          }
        </div>
      </div>
    `;
  }
}

customElements.define("openclaw-chat-clawhub-card", ChatClawHubCard);
