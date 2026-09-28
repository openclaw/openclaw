import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { state, property } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { acquireLobsterdexCatalog } from "../../app/lobsterdex-catalog.ts";
import { getLobsterdexEntries, subscribeLobsterdex } from "../../components/lobster-dex.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderLobsterdex, type LobsterdexCopyFeedback } from "./view.ts";

class LobsterdexPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context?: ApplicationContext;
  private catalog?: ReturnType<typeof acquireLobsterdexCatalog>;
  private stopCatalog?: () => void;
  private stopInventory?: () => void;
  private highlighted = "";

  override connectedCallback(): void {
    super.connectedCallback();
    this.stopInventory = subscribeLobsterdex(() => this.requestUpdate());
  }

  protected override willUpdate(changed: PropertyValues): void {
    if ((changed.has("context") || !this.catalog) && this.context) {
      this.stopCatalog?.();
      this.catalog?.release();
      this.catalog = acquireLobsterdexCatalog(this.context.gateway);
      this.stopCatalog = this.catalog.subscribe(() => this.requestUpdate());
    }
  }

  @state() private copyFeedback: LobsterdexCopyFeedback | null = null;
  private copyAttempt = 0;
  private copyResetTimer: number | null = null;

  override disconnectedCallback(): void {
    this.stopInventory?.();
    this.stopCatalog?.();
    this.catalog?.release();
    this.catalog = undefined;
    this.copyAttempt += 1;
    this.copyFeedback = null;
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    super.disconnectedCallback();
  }

  protected override updated(): void {
    const hashPrefix = "#lobsterdex-";
    if (!location.hash.startsWith(hashPrefix) || this.highlighted === location.hash) {
      return;
    }
    let id: string;
    try {
      id = decodeURIComponent(location.hash.slice(hashPrefix.length));
    } catch {
      return;
    }
    const card = this.querySelector<HTMLElement>(`#${CSS.escape(`lobsterdex-${id}`)}`);
    if (!card) {
      return;
    }
    this.highlighted = location.hash;
    const clearHighlight = (event: AnimationEvent) => {
      // Palette animations bubble through the card too; only its own pulse
      // owns this transient deep-link marker.
      if (event.target !== card || event.animationName !== "lobsterdex-card-highlight") {
        return;
      }
      card.classList.remove("lobsterdex-page__card--highlight");
      card.removeEventListener("animationend", clearHighlight);
    };
    card.addEventListener("animationend", clearHighlight);
    card.classList.add("lobsterdex-page__card--highlight");
    // Double rAF: the workspace shell finishes layout after first render, and
    // scrolling immediately leaves the target beyond the settled viewport.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => card.scrollIntoView({ block: "center" }));
    });
  }

  private readonly copyLink = async (paletteId: string): Promise<void> => {
    const attempt = ++this.copyAttempt;
    this.copyFeedback = null;
    if (this.copyResetTimer !== null) {
      window.clearTimeout(this.copyResetTimer);
      this.copyResetTimer = null;
    }
    const url = `${location.origin}${location.pathname}#lobsterdex-${encodeURIComponent(paletteId)}`;
    const copied = await copyToClipboard(
      url,
      () => this.isConnected && attempt === this.copyAttempt,
    );
    if (!this.isConnected || attempt !== this.copyAttempt) {
      return;
    }
    this.copyFeedback = { paletteId, status: copied ? "copied" : "error" };
    this.copyResetTimer = window.setTimeout(() => {
      this.copyFeedback = null;
      this.copyResetTimer = null;
    }, 1_500);
  };

  override render() {
    return html`
      <section class="content-header">
        <h1 class="page-title">${titleForRoute("lobsterdex")}</h1>
      </section>
      ${
        this.catalog?.snapshot.error
          ? html`<div class="callout danger" role="alert">
              ${this.catalog.snapshot.error}
              <button @click=${() => void this.catalog?.refresh().catch(() => {})}>
                ${t("common.retry")}
              </button>
            </div>`
          : nothing
      }
      ${renderSettingsWorkspace(
        renderLobsterdex(getLobsterdexEntries(), {
          catalog: this.catalog?.snapshot.entries,
          copyFeedback: this.copyFeedback,
          onCopyLink: (paletteId) => void this.copyLink(paletteId),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-lobsterdex-page")) {
  customElements.define("openclaw-lobsterdex-page", LobsterdexPage);
}
