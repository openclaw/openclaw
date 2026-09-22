import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import "../../components/desktop/desktop-panel.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { formatByteSize, formatTimeAgo } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { SystemsController } from "./systems-controller.ts";
import type { SystemsRouteData } from "./systems-controller.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import { systemKind, systemName, systemStatus } from "./systems-sidebar.ts";
import "../../styles/systems.css";

registerSystemsEnglish();

type HostMeasurements = Pick<
  SystemInfoResult,
  | "cpuCount"
  | "loadAverage"
  | "memoryTotalBytes"
  | "memoryFreeBytes"
  | "diskTotalBytes"
  | "diskAvailableBytes"
>;

function measurements(row: SystemsInventoryRow): HostMeasurements | undefined {
  return row.gatewaySystemInfo ?? row.node?.hostStats;
}

function bytes(value: number): string {
  return formatByteSize(value, {
    style: "legacy-binary",
    separator: " ",
    maxUnit: "tera",
    fractionDigits: (size, unit) => (unit === "tera" || size < 10 ? 1 : 0),
  });
}

function renderMeasurements(
  row: SystemsInventoryRow,
  sampledAtMs: number | null,
  connected: boolean,
) {
  const stats = measurements(row);
  if (!stats) {
    return html`<p class="systems-no-telemetry">${t("systems.noTelemetry")}</p>`;
  }
  const observedAt = row.node?.hostStats?.updatedAtMs ?? sampledAtMs;
  const lastKnown =
    !connected ||
    row.environment.status !== "available" ||
    (observedAt !== null && Date.now() - observedAt > 30_000);
  return html`<div class="systems-metrics" data-stale=${lastKnown}>
    <div>
      <span>${t("systems.load")}</span
      ><strong
        >${stats.loadAverage ? stats.loadAverage[0].toFixed(2) : t("systems.unavailable")}</strong
      ><small>${t("systems.cpuCount", { count: String(stats.cpuCount) })}</small>
    </div>
    <div>
      <span>${t("systems.memory")}</span
      ><strong
        >${bytes(stats.memoryTotalBytes - stats.memoryFreeBytes)}
        <small>/ ${bytes(stats.memoryTotalBytes)}</small></strong
      >
    </div>
    <div>
      <span>${t("systems.disk")}</span
      ><strong
        >${stats.diskAvailableBytes === undefined ? t("systems.unavailable") : bytes(stats.diskAvailableBytes)}</strong
      >
    </div>
    ${observedAt === null ? nothing : html`<span class="systems-sample-time">${t(lastKnown ? "systems.lastKnown" : "systems.sampled", { time: formatTimeAgo(Math.max(0, Date.now() - observedAt)) })}</span>`}
  </div>`;
}

class SystemsPage extends OpenClawLightDomElement {
  @property({ attribute: false }) routeData?: SystemsRouteData;
  @property({ type: Boolean }) presented = true;
  private activeController: SystemsController | undefined;
  private readonly poll = new PollController(this, 15_000, () => {
    if (
      this.presented &&
      document.visibilityState !== "hidden" &&
      (this.routeData?.controller.showStats || this.routeData?.controller.showDetails)
    ) {
      void this.routeData?.controller.refreshTelemetry();
    }
  });

  constructor() {
    super();
    void this.poll;
    new SubscriptionsController(this).watch(
      () => this.routeData?.controller,
      (controller, notify) => controller.subscribe(notify),
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.handleDesktopToggle);
  }

  override disconnectedCallback(): void {
    window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.handleDesktopToggle);
    this.activeController?.setPresented(false);
    this.activeController = undefined;
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("routeData") || changed.has("presented")) {
      if (this.activeController !== this.routeData?.controller) {
        this.activeController?.setPresented(false);
      }
      this.activeController = this.routeData?.controller;
      this.activeController?.setPresented(this.presented);
    }
  }

  private readonly handleDesktopToggle = (event: Event) => {
    const controller = this.routeData?.controller;
    if (!this.presented || !controller?.current || !(event instanceof CustomEvent)) {
      return;
    }
    const detail = isRecord(event.detail) ? event.detail : {};
    const environmentId =
      typeof detail.environmentId === "string" ? detail.environmentId : undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (detail?.open === false) {
      this.querySelector("openclaw-desktop-panel")?.handleToggleRequest(event);
      return;
    }
    if (environmentId && environmentId !== controller.selectedId) {
      controller.select(environmentId);
      if (!controller.rows.some((row) => row.environment.id === environmentId)) {
        void controller.refresh();
      }
      return;
    }
    if (environmentId) {
      this.querySelector("openclaw-desktop-panel")?.handleToggleRequest(event);
    }
  };

  private renderDetails(controller: SystemsController, row: SystemsInventoryRow) {
    const environment = row.environment;
    return html`<aside class="systems-details" aria-label=${t("systems.details")}>
      <header>
        <h2>${t("systems.details")}</h2>
        <button
          class="systems-icon-button"
          aria-label=${t("systems.closeDetails")}
          @click=${() => controller.toggleDetails()}
        >
          ${icons.x}
        </button>
      </header>
      <dl>
        <dt>${t("systems.identifier")}</dt>
        <dd>${environment.id}</dd>
        <dt>${t("systems.status")}</dt>
        <dd>${controller.connected ? systemStatus(row) : t("systems.offline")}</dd>
        <dt>${t("systems.platform")}</dt>
        <dd>${environment.platform ?? row.node?.platform ?? t("systems.unknown")}</dd>
      </dl>
      <h3>${t("systems.telemetry")}</h3>
      ${renderMeasurements(row, controller.sampledAtMs, controller.connected)}
      <h3>${t("systems.relatedSessions")}</h3>
      <p class="systems-detail-hint">${t("systems.relatedHint")}</p>
      ${
        row.sessions.length
          ? row.sessions.map((relation) => {
              const session = relation.session;
              const face = resolveSessionPreferredFace(session);
              const target = sessionNavigationTarget({
                context: controller.context,
                face,
                sessionKey: session.key,
                preferenceDerivedFace: true,
              });
              return html`<a
                class="systems-session-link"
                href=${target.href}
                @click=${(event: MouseEvent) => {
                  if (!shouldHandleNavigationClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  controller.context.navigate(face, target.options);
                }}
                ><strong>${session.displayName ?? session.label ?? session.key}</strong
                ><span>${t("systems.relations." + relation.kind)}</span></a
              >`;
            })
          : html`<p class="systems-detail-hint">${t("systems.noRelatedSessions")}</p>`
      }
      ${
        environment.worker?.attachedSessionIds.length
          ? html`<h3>${t("systems.attachedSessions")}</h3>
              <p class="systems-detail-hint">${t("systems.attachedHint")}</p>
              <ul>
                ${environment.worker.attachedSessionIds.map((id) => html`<li>${id}</li>`)}
              </ul>`
          : nothing
      }
      <h3>${t("systems.capabilities")}</h3>
      <div class="systems-capabilities">
        ${(environment.capabilities ?? []).map((capability) => html`<span>${capability}</span>`)}
      </div>
    </aside>`;
  }

  override render() {
    const controller = this.routeData?.controller;
    if (!controller?.current) {
      return html`<p class="systems-state" role="status">${t("systems.loading")}</p>`;
    }
    const row = controller.selected;
    const canView = Boolean(
      row?.environment.desktop &&
      row.environment.status === "available" &&
      controller.desktopAvailable &&
      this.presented,
    );
    const title = row ? systemName(row) : t("systems.title");
    const auxiliaryErrors = Object.values(controller.inventory?.errors ?? {});
    const emptyTitle = !controller.connected
      ? t("systems.offlineGateway")
      : controller.loading && !controller.inventory
        ? t("systems.loading")
        : controller.selectedId && !row
          ? t("systems.missingTitle")
          : !row
            ? t("systems.select")
            : row.environment.status !== "available"
              ? row.environment.status === "unavailable"
                ? t("systems.offlineTitle")
                : systemStatus(row)
              : !row.environment.desktop
                ? t("systems.noDesktopTitle")
                : t("systems.accessTitle");
    const emptyHint =
      controller.selectedId && !row
        ? t("systems.missingHint")
        : !row
          ? t("systems.selectHint")
          : row.environment.status !== "available"
            ? t("systems.offlineHint")
            : !row.environment.desktop
              ? t("systems.noDesktopHint")
              : t("systems.accessHint");
    return html`<section class="systems-workspace" aria-label=${t("systems.title")}>
      <header class="systems-toolbar">
        <div class="systems-heading">
          <h1>${title}</h1>
          <span>${row ? t("systems." + systemKind(row)) : t("systems.selectHint")}</span>
        </div>
        <select
          class="systems-mobile-picker"
          aria-label=${t("systems.select")}
          @change=${(event: Event) => {
            if (event.currentTarget instanceof HTMLSelectElement) {
              controller.select(event.currentTarget.value);
            }
          }}
        >
          <option value="" disabled .selected=${!row}>${t("systems.select")}</option>
          ${controller.rows.map((entry) => html`<option value=${entry.environment.id} .selected=${entry.environment.id === controller.selectedId}>${systemName(entry)}</option>`)}
        </select>
        <button
          class="systems-icon-button"
          title=${t(controller.showStats ? "systems.hideStats" : "systems.stats")}
          aria-label=${t(controller.showStats ? "systems.hideStats" : "systems.stats")}
          aria-pressed=${controller.showStats}
          @click=${() => controller.toggleStats()}
        >
          ${icons.activity}
        </button>
        <button
          class="systems-icon-button"
          title=${t("systems.details")}
          aria-label=${t("systems.details")}
          aria-pressed=${controller.showDetails}
          ?disabled=${!row}
          @click=${() => controller.toggleDetails()}
        >
          ${icons.panelRightOpen}
        </button>
      </header>
      ${controller.error ? html`<div class="systems-callout systems-callout--error" role="alert">${controller.error}<button @click=${() => void controller.refresh()} ?disabled=${controller.loading}>${t("common.retry")}</button></div>` : nothing}
      ${!controller.connected ? html`<div class="systems-callout" role="status">${t("systems.offlineGateway")}</div>` : nothing}
      ${
        auxiliaryErrors.length
          ? html`<details class="systems-callout">
              <summary>${t("systems.errors")}</summary>
              ${auxiliaryErrors.map((error) => html`<p>${error}</p>`)}
            </details>`
          : nothing
      }
      ${controller.showStats && row ? renderMeasurements(row, controller.sampledAtMs, controller.connected) : nothing}
      <div class="systems-body">
        <div class="systems-desktop">
          ${
            canView && row
              ? html`<openclaw-desktop-panel
                  embedded
                  data-chat-autotype-exempt
                  .client=${controller.context.gateway.snapshot.client}
                  .available=${controller.desktopAvailable}
                  .presented=${this.presented}
                  .workspaceControls=${true}
                  .suppliedEnvironments=${controller.inventory?.environments ?? []}
                  .requestedSource=${row.environment.id}
                  .basePath=${controller.context.basePath}
                ></openclaw-desktop-panel>`
              : html`<div class="systems-state" role="status">
                  <span class="systems-state__icon" aria-hidden="true">${icons.monitor}</span>
                  <h2>${emptyTitle}</h2>
                  <p>${emptyHint}</p>
                  ${row ? html`<button class="systems-text-button" @click=${() => controller.toggleDetails()}>${t("systems.details")}</button>` : nothing}
                </div>`
          }
        </div>
        ${controller.showDetails && row ? this.renderDetails(controller, row) : nothing}
      </div>
    </section>`;
  }
}

if (!customElements.get("openclaw-systems-page")) {
  customElements.define("openclaw-systems-page", SystemsPage);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-systems-page": SystemsPage;
  }
}

/** Route rendering stays in the lazy page module, not in startup route metadata. */
export function render(data: SystemsRouteData | undefined, _pending: boolean, presented = true) {
  return data
    ? html`<openclaw-systems-page
        .routeData=${data}
        .presented=${presented}
      ></openclaw-systems-page>`
    : nothing;
}

export function renderSidebar(data: SystemsRouteData | undefined) {
  return data
    ? html`<openclaw-systems-sidebar .controller=${data.controller}></openclaw-systems-sidebar>`
    : nothing;
}

export function load(context: ApplicationContext<RouteId>): SystemsRouteData {
  return { controller: new SystemsController(context) };
}
