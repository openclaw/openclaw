import { consume } from "@lit/context";
import type {
  EnvironmentSummary,
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { icon } from "../../components/icons.ts";
import type { PortalPanelToggleDetail } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerPortalsEnglish } from "../../i18n/locales/en-portals.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { probePortalReachable, type PortalReachability } from "./portal-reachability.ts";
import { portalNeedsNewTab, portalNeedsRemoteIngress } from "./portal-url.ts";
import "./portals.css";

registerPortalsEnglish();

const PORTAL_FRAME_SANDBOX =
  "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts";

type PortalProbeState = {
  key: string;
  status: "probing" | "ingress-required" | "new-tab-required" | PortalReachability;
};

class PortalsPage extends OpenClawLightDomElement {
  @property({ type: Boolean, reflect: true }) embedded = false;
  @property({ type: Boolean }) presented = true;
  @property({ attribute: false }) requestedPortalId: string | null = null;
  @property({ attribute: false }) requestedEnvironmentId: string | null = null;
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private portals: PortalSummary[] = [];
  @state() private selectedPortalId: string | null = null;
  @state() private loading = false;
  @state() private loaded = false;
  @state() private error: string | null = null;
  @state() private closingPortalId: string | null = null;
  @state() private portalProbeState: PortalProbeState | null = null;
  @state() private pendingEnvironment: EnvironmentSummary | null = null;
  @state() private environmentFailure: { environmentId: string; message: string } | null = null;
  private environmentRequestGeneration = 0;
  private environmentLoading = false;
  private readonly environmentPoll = new PollController(
    this,
    2_000,
    () => void this.loadPendingEnvironment(),
    false,
  );

  private requestGeneration = 0;
  private portalSetRevision = 0;
  private portalProbeGeneration = 0;
  private readonly portalProbeCache = new Map<string, PortalReachability>();
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    ensureInitialData: () => void this.loadPresentation(),
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) =>
      gateway.subscribeEvents((event) => {
        if (
          this.gateway.gateway !== gateway ||
          this.context.gateway !== gateway ||
          !this.gateway.connected ||
          event.event !== "portal.changed"
        ) {
          return;
        }
        void this.loadPresentation();
      }),
  );

  override disconnectedCallback() {
    this.environmentRequestGeneration += 1;
    this.portalProbeGeneration += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>) {
    // The Gateway lifecycle owns the initial fetch, including an initial explicit target.
    if (
      ["requestedPortalId", "requestedEnvironmentId"].some(
        (key) => changed.has(key) && changed.get(key) !== undefined,
      )
    ) {
      this.requestGeneration += 1;
      this.environmentRequestGeneration += 1;
      this.environmentLoading = false;
      this.pendingEnvironment = null;
      this.environmentFailure = null;
      this.environmentPoll.stop();
      this.loading = false;
      this.portalProbeGeneration += 1;
      this.portalProbeState = null;
      this.applyPortalSet(this.portals);
      void this.loadPresentation();
    } else if (
      changed.has("presented") &&
      changed.get("presented") !== undefined &&
      this.presented
    ) {
      void this.loadPresentation();
    } else if (changed.has("presented") && !this.presented) {
      this.environmentPoll.stop();
      this.environmentRequestGeneration += 1;
      this.environmentLoading = false;
    }
  }

  handleToggleRequest(event: Event): void {
    // SAFETY: the shared typed panel-toggle dispatcher owns this event's detail.
    const detail = event instanceof CustomEvent ? (event.detail as PortalPanelToggleDetail) : null;
    if (detail?.open === false) {
      return;
    }
    if (
      detail?.portalId &&
      (detail.portalId !== this.requestedPortalId || this.requestedEnvironmentId !== null)
    ) {
      this.requestedPortalId = detail.portalId;
      this.requestedEnvironmentId = null;
      return;
    } else if (
      detail?.environmentId &&
      (detail.environmentId !== this.requestedEnvironmentId || this.requestedPortalId !== null)
    ) {
      this.requestedEnvironmentId = detail.environmentId;
      this.requestedPortalId = null;
      return;
    }
    void this.loadPresentation();
  }

  private get pendingEnvironmentId(): string | null {
    return this.requestedPortalId ? null : this.requestedEnvironmentId;
  }

  private async loadPresentation(): Promise<void> {
    if (this.pendingEnvironmentId) {
      await this.loadPendingEnvironment();
    } else {
      await this.loadPortals();
    }
  }

  private async loadPendingEnvironment(): Promise<void> {
    const environmentId = this.pendingEnvironmentId;
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (
      !environmentId ||
      !client ||
      !scope ||
      this.environmentLoading ||
      (this.embedded && !this.presented)
    ) {
      return;
    }
    const generation = ++this.environmentRequestGeneration;
    const isCurrent = () =>
      this.gateway.isCurrent(scope) &&
      generation === this.environmentRequestGeneration &&
      this.pendingEnvironmentId === environmentId;
    this.environmentLoading = true;
    this.environmentFailure = null;
    try {
      const environment = await client.request<EnvironmentSummary>("environments.status", {
        environmentId,
      });
      if (!isCurrent()) {
        return;
      }
      if (environment.id !== environmentId) {
        throw new Error("Environment status returned a different target");
      }
      this.pendingEnvironment = environment;
      if (environment.status === "starting") {
        this.environmentPoll.start();
      } else {
        this.environmentPoll.stop();
      }
    } catch (error) {
      if (isCurrent()) {
        this.environmentFailure = { environmentId, message: formatUiError(error) };
        this.environmentPoll.stop();
      }
    } finally {
      if (isCurrent()) {
        this.environmentLoading = false;
      }
    }
  }

  private get portalListSupported(): boolean {
    return isGatewayMethodAdvertised(this.gateway.snapshot ?? {}, "portal.list") !== false;
  }

  private get canClosePortal(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "portal.close", "operator.write");
  }

  private resetGatewayState() {
    this.environmentRequestGeneration += 1;
    this.environmentLoading = false;
    this.pendingEnvironment = null;
    this.environmentFailure = null;
    this.environmentPoll.stop();
    this.requestGeneration += 1;
    this.portalSetRevision += 1;
    this.portals = [];
    this.selectedPortalId = null;
    this.loading = false;
    this.loaded = false;
    this.error = null;
    this.closingPortalId = null;
    this.portalProbeGeneration += 1;
    this.portalProbeCache.clear();
    this.portalProbeState = null;
  }

  private applyPortalSet(portals: readonly PortalSummary[]) {
    this.portalSetRevision += 1;
    this.portals = [...portals];
    const previousPortalId = this.selectedPortalId;
    const selectedPortalId = this.pendingEnvironmentId
      ? null
      : (this.requestedPortalId ??
        (portals.some((portal) => portal.id === previousPortalId)
          ? this.selectedPortalId
          : (portals[0]?.id ?? null)));
    this.selectedPortalId = selectedPortalId;
    this.loaded = true;
    this.error = null;
    const selectedPortal = portals.find((portal) => portal.id === selectedPortalId);
    if (selectedPortal) {
      this.ensurePortalProbe(selectedPortal, selectedPortalId !== previousPortalId);
    } else {
      this.portalProbeGeneration += 1;
      this.portalProbeState = null;
    }
  }

  private ensurePortalProbe(portal: PortalSummary, force = false) {
    if (!portal.tokenQuery || !portal.url) {
      this.portalProbeGeneration += 1;
      this.portalProbeState = null;
      return;
    }
    const url = portal.url;
    const key = `${portal.id}\u0000${url}`;
    if (!force && this.portalProbeState?.key === key) {
      return;
    }
    if (portalNeedsRemoteIngress(url, this.context.gateway.connection.gatewayUrl)) {
      this.portalProbeGeneration += 1;
      this.portalProbeState = { key, status: "ingress-required" };
      return;
    }
    if (portalNeedsNewTab(url, location.href)) {
      this.portalProbeGeneration += 1;
      this.portalProbeState = { key, status: "new-tab-required" };
      return;
    }
    const cached = force ? undefined : this.portalProbeCache.get(key);
    if (cached !== undefined) {
      this.portalProbeState = { key, status: cached };
      return;
    }

    const generation = ++this.portalProbeGeneration;
    this.portalProbeState = { key, status: "probing" };
    void probePortalReachable(url).then((reachability) => {
      if (generation === this.portalProbeGeneration && this.portalProbeState?.key === key) {
        this.portalProbeCache.set(key, reachability);
        this.portalProbeState = { key, status: reachability };
      }
    });
  }

  private selectPortal(portal: PortalSummary) {
    if (portal.id === this.selectedPortalId) {
      return;
    }
    this.selectedPortalId = portal.id;
    this.ensurePortalProbe(portal, true);
  }

  private async loadPortals() {
    if (
      this.pendingEnvironmentId ||
      !this.gateway.connected ||
      !this.portalListSupported ||
      this.loading ||
      (this.embedded && !this.presented)
    ) {
      return;
    }
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!client || !scope) {
      return;
    }
    const generation = ++this.requestGeneration;
    const portalSetRevision = this.portalSetRevision;
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<PortalListResult>("portal.list", {});
      if (
        generation === this.requestGeneration &&
        portalSetRevision === this.portalSetRevision &&
        this.gateway.isCurrent(scope)
      ) {
        this.applyPortalSet(result.portals);
      }
    } catch (error) {
      if (
        generation === this.requestGeneration &&
        this.gateway.isCurrent(scope) &&
        this.portalListSupported
      ) {
        this.error = t("portalsPage.loadFailed", { error: formatUiError(error) });
        this.loaded = true;
      }
    } finally {
      if (generation === this.requestGeneration && this.gateway.isCurrent(scope)) {
        this.loading = false;
      }
    }
  }

  private async closePortal(portal: PortalSummary) {
    if (!this.canClosePortal || this.closingPortalId) {
      return;
    }
    const client = this.gateway.client;
    const scope = this.gateway.capture();
    if (!client || !scope) {
      return;
    }
    this.closingPortalId = portal.id;
    this.error = null;
    try {
      await client.request<PortalCloseResult>("portal.close", { id: portal.id });
      if (this.gateway.isCurrent(scope)) {
        void this.loadPortals();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = t("portalsPage.closeFailed", { error: formatUiError(error) });
      }
    } finally {
      if (this.gateway.isCurrent(scope) && this.closingPortalId === portal.id) {
        this.closingPortalId = null;
      }
    }
  }

  private renderEmptyState() {
    const unsupported = !this.portalListSupported;
    return html`
      <section class="portals-empty" role="status" aria-live="polite">
        ${
          this.loading && !this.loaded
            ? html`<div class="portals-empty__title">${t("portalsPage.loading")}</div>`
            : html`
                <div class="portals-empty__title">
                  ${t(this.requestedPortalId ? "portalsPage.unavailable" : "portalsPage.emptyHint")}
                </div>
                ${
                  this.requestedPortalId
                    ? nothing
                    : html`<div class="portals-empty__prompts">
                        <span>${t("portalsPage.promptShow")}</span>
                        <span>${t("portalsPage.promptStart")}</span>
                        <span>${t("portalsPage.promptMakeAvailable")}</span>
                      </div>`
                }
              `
        }
        ${
          unsupported
            ? html`<div class="portals-empty__note">${t("portalsPage.unsupported")}</div>`
            : nothing
        }
        ${this.error ? html`<div class="callout danger">${this.error}</div>` : nothing}
      </section>
    `;
  }

  private renderPortal(portal: PortalSummary) {
    if (!portal.tokenQuery || !portal.url) {
      return html`
        <section class="portals-preview">
          <div class="portals-preview__notice" role="status">
            <div class="portals-preview__notice-title">
              ${t("portalsPage.writeAccessRequiredTitle")}
            </div>
            <p>${t("portalsPage.writeAccessRequiredBody")}</p>
          </div>
        </section>
      `;
    }
    const portalUrl = portal.url;
    const displayUrl = new URL(portalUrl);
    displayUrl.search = "";
    const frameKey = `${portal.id}\u0000${portalUrl}`;
    const probeStatus =
      this.portalProbeState?.key === frameKey ? this.portalProbeState.status : "probing";
    return html`
      <section class="portals-preview">
        <header class="portals-preview__header">
          <a
            class="portals-preview__url"
            href=${portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title=${displayUrl.href}
          >
            <span>${displayUrl.href}</span>
            ${icon("externalLink")}
            <span class="sr-only">${t("portalsPage.openNewTab")}</span>
          </a>
          <button
            class="btn btn--icon btn--ghost portals-preview__close"
            type="button"
            title=${t("portalsPage.closePortal", { title: portal.title })}
            aria-label=${t("portalsPage.closePortal", { title: portal.title })}
            ?disabled=${!this.canClosePortal || this.closingPortalId === portal.id}
            @click=${() => void this.closePortal(portal)}
          >
            ${icon("x")}
          </button>
        </header>
        ${
          this.error
            ? html`<div class="callout danger portals-preview__error" role="alert">
                ${this.error}
              </div>`
            : nothing
        }
        ${
          probeStatus === "probing"
            ? html`
                <div class="portals-empty portals-preview__state" role="status" aria-live="polite">
                  <div class="portals-empty__title">${t("portalsPage.loading")}</div>
                </div>
              `
            : probeStatus === "unreachable" ||
                probeStatus === "ingress-required" ||
                probeStatus === "new-tab-required"
              ? html`
                  <div class="portals-preview__notice" role="status">
                    <div class="portals-preview__notice-title">
                      ${t(
                        probeStatus === "new-tab-required"
                          ? "portalsPage.newTabRequiredTitle"
                          : probeStatus === "ingress-required"
                            ? "portalsPage.ingressRequiredTitle"
                            : "portalsPage.unreachableTitle",
                      )}
                    </div>
                    <p>
                      ${t(
                        probeStatus === "new-tab-required"
                          ? "portalsPage.newTabRequiredBody"
                          : probeStatus === "ingress-required"
                            ? "portalsPage.ingressRequiredBody"
                            : "portalsPage.unreachableBody",
                      )}
                    </p>
                    <a
                      class="portals-preview__notice-url"
                      href=${portalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      >${displayUrl.href}</a
                    >
                    <button
                      class="btn"
                      type="button"
                      @click=${() => this.ensurePortalProbe(portal, true)}
                    >
                      ${t("portalsPage.retry")}
                    </button>
                  </div>
                `
              : keyed(
                  frameKey,
                  html`<iframe
                    ${ref((element) => {
                      if (element instanceof HTMLIFrameElement && !element.hasAttribute("src")) {
                        element.setAttribute("src", portalUrl);
                      }
                    })}
                    class="portals-preview__frame"
                    title=${t("portalsPage.previewTitle", { title: portal.title })}
                    referrerpolicy="no-referrer"
                    sandbox=${PORTAL_FRAME_SANDBOX}
                  ></iframe>`,
                )
        }
      </section>
    `;
  }

  override render() {
    if (this.pendingEnvironmentId) {
      const environment =
        this.pendingEnvironment?.id === this.pendingEnvironmentId ? this.pendingEnvironment : null;
      const error =
        this.environmentFailure?.environmentId === this.pendingEnvironmentId
          ? this.environmentFailure.message
          : null;
      const failed =
        error ||
        (environment && environment.status !== "starting" && environment.status !== "available");
      return html`<section class="portals-empty" role="status" aria-live="polite">
        <div class="portals-empty__title">
          ${t(failed ? "portalsPage.environmentUnavailable" : environment?.status === "available" ? "portalsPage.waitingForApp" : "portalsPage.environmentStarting")}
        </div>
        ${error || environment?.worker?.error ? html`<p>${error ?? environment?.worker?.error}</p>` : nothing}
        ${failed ? html`<button class="btn" type="button" @click=${() => void this.loadPendingEnvironment()}>${t("portalsPage.retry")}</button>` : nothing}
      </section>`;
    }
    const selectedPortal = this.portals.find(
      (portal) => portal.id === (this.requestedPortalId ?? this.selectedPortalId),
    );
    if (this.embedded) {
      return html`<div class="portals-embedded">
        ${selectedPortal ? this.renderPortal(selectedPortal) : this.renderEmptyState()}
      </div>`;
    }
    return html`
      <section class="content-header content-header--page">
        <div>
          <h1 class="page-title">${titleForRoute("portals")}</h1>
        </div>
      </section>
      ${
        selectedPortal
          ? html`
              <section class="portals-layout">
                <aside class="portals-rail" aria-label=${t("portalsPage.listLabel")}>
                  ${this.portals.map(
                    (portal) => html`
                      <button
                        class="portals-rail__item ${portal.id === selectedPortal.id ? "active" : ""}"
                        type="button"
                        aria-current=${portal.id === selectedPortal.id ? "true" : nothing}
                        @click=${() => this.selectPortal(portal)}
                      >
                        <span class="portals-rail__title">${portal.title}</span>
                        <span class="portals-rail__port"
                          >${t("portalsPage.portLabel", { port: String(portal.port) })}</span
                        >
                        ${
                          portal.description
                            ? html`<span class="portals-rail__description"
                                >${portal.description}</span
                              >`
                            : nothing
                        }
                      </button>
                    `,
                  )}
                </aside>
                ${this.renderPortal(selectedPortal)}
              </section>
            `
          : this.renderEmptyState()
      }
    `;
  }
}

if (!customElements.get("openclaw-portals-page")) {
  customElements.define("openclaw-portals-page", PortalsPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-portals-page": PortalsPage;
  }
}
