import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../../i18n/locales/en-agents-home.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { searchOfficialClaws, type ClawCatalogEntry } from "./claws-catalog-client.ts";
import "../../styles/agents-home.css";

registerAgentsHomeEnglish();

export class ClawsExplore extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) onSelect?: (entry: ClawCatalogEntry) => void;

  @state() private entries: ClawCatalogEntry[] = [];
  @state() private query = "";
  @state() private loading = false;
  @state() private error: string | null = null;

  private searchRevision = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedForConnection = false;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.query = "";
    },
    invalidateRequests: () => {
      this.searchRevision += 1;
      this.clearSearchTimer();
      this.loadedForConnection = false;
      this.entries = [];
      this.loading = false;
      this.error = null;
    },
    onSnapshot: () => {
      if (this.gateway.connected && this.canSearch() && !this.loadedForConnection) {
        void this.loadCatalog();
      }
    },
  });

  override disconnectedCallback() {
    this.clearSearchTimer();
    super.disconnectedCallback();
  }

  private clearSearchTimer() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private canSearch(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "claws.catalog.search", "operator.read");
  }

  private async loadCatalog() {
    const scope = this.gateway.capture();
    if (!scope || !this.canSearch()) {
      return;
    }
    const revision = ++this.searchRevision;
    this.loadedForConnection = true;
    this.entries = [];
    this.loading = true;
    this.error = null;
    try {
      const entries = await searchOfficialClaws(scope.client, this.query);
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.entries = entries;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.error = formatUiError(error, t("clawsCatalog.unavailable"));
      }
    } finally {
      if (this.gateway.isCurrent(scope) && revision === this.searchRevision) {
        this.loading = false;
      }
    }
  }

  private search(query: string) {
    this.query = query;
    this.searchRevision += 1;
    this.clearSearchTimer();
    this.entries = [];
    this.loading = true;
    this.error = null;
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.loadCatalog();
    }, 150);
  }

  override render() {
    const unavailable = this.gateway.connected && !this.canSearch();
    return html`<section
      class="agents-home__explore"
      data-claws-explore
      aria-label=${t("clawsCatalog.explore")}
    >
      <div class="agents-home__explore-toolbar">
        <h2>${t("clawsCatalog.explore")}</h2>
        <label class="agents-home__claw-search">
          <span aria-hidden="true">${icons.search}</span>
          <input
            type="search"
            data-claws-search
            aria-label=${t("clawsCatalog.search")}
            placeholder=${t("clawsCatalog.searchPlaceholder")}
            .value=${this.query}
            ?disabled=${!this.gateway.connected || unavailable}
            @input=${(event: InputEvent) => {
              const target = event.currentTarget;
              if (target instanceof HTMLInputElement) {
                this.search(target.value);
              }
            }}
          />
        </label>
      </div>
      ${
        unavailable
          ? html`<div class="callout warn" role="status">${t("clawsCatalog.unavailable")}</div>`
          : nothing
      }
      ${
        this.error
          ? html`<div class="callout danger" role="alert">
              ${this.error}
              <button type="button" class="btn btn--sm" @click=${() => void this.loadCatalog()}>
                ${t("clawsCatalog.retry")}
              </button>
            </div>`
          : nothing
      }
      ${
        this.loading
          ? html`<div
              class="agents-home__claw-grid"
              role="status"
              aria-label=${t("clawsCatalog.loading")}
            >
              ${[0, 1, 2, 3].map(
                () => html`<div class="agents-home__claw-skeleton" aria-hidden="true"></div>`,
              )}
            </div>`
          : nothing
      }
      ${
        this.gateway.connected &&
        !unavailable &&
        !this.loading &&
        !this.error &&
        this.entries.length === 0
          ? html`<p class="agents-home__claw-empty">${t("clawsCatalog.empty")}</p>`
          : nothing
      }
      <div class="agents-home__claw-grid">
        ${repeat(
          this.entries,
          (entry) => entry.packageName,
          (entry) => html`<article
            class="agents-home__claw-card oc-card oc-card-interactive"
            data-claws-entry
          >
            <div class="agents-home__claw-head">
              <span class="agents-home__claw-art" aria-hidden="true">${icons.box}</span>
              <div class="agents-home__claw-identity">
                <h3>${entry.displayName}</h3>
                <span>${t("clawsCatalog.official")}</span>
              </div>
              <button
                type="button"
                class="btn btn--sm oc-action oc-action-secondary"
                ?disabled=${!entry.latestVersion}
                title=${entry.latestVersion ? t("clawsCatalog.review") : t("clawsCatalog.noVersion")}
                @click=${() => this.onSelect?.(entry)}
              >
                ${t("clawsCatalog.add")}
              </button>
            </div>
            ${entry.summary ? html`<p class="agents-home__claw-summary">${entry.summary}</p>` : nothing}
            <div class="agents-home__claw-meta">
              <span title=${entry.packageName}>${entry.packageName}</span>
              ${
                entry.latestVersion
                  ? html`<span
                      >${t("clawsCatalog.version", { version: entry.latestVersion })}</span
                    >`
                  : nothing
              }
              <span
                >${t("clawsCatalog.downloads", { count: new Intl.NumberFormat().format(entry.downloads) })}</span
              >
            </div>
          </article>`,
        )}
      </div>
    </section>`;
  }
}

if (!customElements.get("openclaw-claws-explore")) {
  customElements.define("openclaw-claws-explore", ClawsExplore);
}
