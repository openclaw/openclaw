import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import type { LobsterPetPaletteId } from "../../components/lobster-pet-contract.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderLobsterdex, type LobsterdexCopyFeedback } from "./view.ts";

class LobsterdexPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  private readonly subscriptions = new SubscriptionsController(this).watchStore(
    () => this.context?.theme,
  );
  @state() private copyFeedback: LobsterdexCopyFeedback | null = null;
  private copyAttempt = 0;
  private copyResetTimer: number | null = null;

  override disconnectedCallback(): void {
    this.subscriptions.clear();
    this.copyAttempt += 1;
    this.copyFeedback = null;
    window.clearTimeout(this.copyResetTimer ?? undefined);
    this.copyResetTimer = null;
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    const hashPrefix = "#lobsterdex-";
    if (!location.hash.startsWith(hashPrefix)) {
      return;
    }
    const palette = LOBSTER_PET_PALETTES.find(
      (entry) => entry.id === location.hash.slice(hashPrefix.length),
    );
    if (!palette) {
      return;
    }
    const card = this.querySelector<HTMLElement>(`#lobsterdex-${palette.id}`);
    if (!card) {
      return;
    }
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

  private readonly copyLink = async (paletteId: LobsterPetPaletteId): Promise<void> => {
    const attempt = ++this.copyAttempt;
    this.copyFeedback = null;
    window.clearTimeout(this.copyResetTimer ?? undefined);
    this.copyResetTimer = null;
    const url = `${location.origin}${location.pathname}#lobsterdex-${paletteId}`;
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
      <section class="content-header" ${shellLayoutTraits({ toolbarHeader: true })}>
        <h1 class="page-title">${titleForRoute("lobsterdex")}</h1>
      </section>
      ${renderSettingsWorkspace(
        !this.context.theme.branding.lobsterdex
          ? html`<section class="settings-section" role="status">
              <p>${t("quickSettings.appearance.lobsterdexThemeHidden")}</p>
              <a
                class="btn btn--sm"
                href=${pathForRoute("appearance", this.context.basePath)}
                @click=${(event: MouseEvent) => {
                  if (shouldHandleNavigationClick(event)) {
                    event.preventDefault();
                    this.context.navigate("appearance");
                  }
                }}
                >${titleForRoute("appearance")}</a
              >
            </section>`
          : renderLobsterdex(getLobsterdexEntries(), {
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
