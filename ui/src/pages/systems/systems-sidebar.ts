import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { SystemsController } from "./systems-controller.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import "../../styles/systems.css";

registerSystemsEnglish();

export function systemName(row: SystemsInventoryRow): string {
  return (
    row.gatewaySystemInfo?.machineName ??
    row.environment.label ??
    row.node?.displayName ??
    (row.environment.id === "gateway" ? t("systems.host") : row.environment.id)
  );
}

export function systemKind(row: SystemsInventoryRow): "host" | "worker" | "node" {
  return row.environment.id === "gateway"
    ? "host"
    : row.environment.type === "node"
      ? "node"
      : "worker";
}

export function systemStatus(row: SystemsInventoryRow): string {
  return t(
    row.environment.status === "available"
      ? "systems.online"
      : row.environment.status === "unavailable"
        ? "systems.offline"
        : "systems.statuses." + row.environment.status,
  );
}

class SystemsSidebar extends OpenClawLightDomElement {
  @property({ attribute: false }) controller?: SystemsController;

  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.controller,
      (controller, notify) => controller.subscribe(notify),
    );
  }

  override render() {
    const controller = this.controller;
    if (!controller?.current) {
      return nothing;
    }
    const query = controller.query.trim().toLocaleLowerCase();
    const rows = controller.rows.filter((row) =>
      [
        systemName(row),
        row.environment.id,
        row.environment.platform ?? row.node?.platform ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    );
    return html`<section class="systems-sidebar" aria-label=${t("systems.inventory")}>
      <header class="systems-sidebar__header">
        <h2>${t("systems.inventory")}</h2>
        <span>${controller.rows.length}</span>
        <button
          type="button"
          class="systems-icon-button"
          aria-label=${t("systems.refresh")}
          title=${t("systems.refresh")}
          ?disabled=${controller.loading || !controller.connected}
          @click=${() => void controller.refresh()}
        >
          ${icons.refresh}
        </button>
      </header>
      <label class="systems-search">
        <span aria-hidden="true">${icons.search}</span>
        <input
          type="search"
          aria-label=${t("systems.search")}
          placeholder=${t("systems.search")}
          .value=${controller.query}
          @input=${(event: InputEvent) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              controller.search(event.currentTarget.value);
            }
          }}
        />
      </label>
      <div class="systems-sidebar__list" aria-busy=${controller.loading}>
        ${controller.loading && !controller.inventory ? html`<p class="systems-sidebar__empty" role="status">${t("systems.loading")}</p>` : nothing}
        ${(["host", "worker", "node"] as const).map((kind) => {
          const group = rows.filter((row) => systemKind(row) === kind);
          return group.length
            ? html`<section class="systems-group">
                <h3>
                  ${t(kind === "host" ? "systems.hosts" : kind === "worker" ? "systems.workers" : "systems.nodes")}
                </h3>
                ${group.map(
                  (row) => html`<button
                    class="systems-machine"
                    type="button"
                    aria-pressed=${row.environment.id === controller.selectedId}
                    @click=${() => controller.select(row.environment.id)}
                  >
                    <span class="systems-machine__icon" aria-hidden="true"
                      >${row.environment.desktop ? icons.monitor : icons.server}</span
                    >
                    <span class="systems-machine__copy"
                      ><strong>${systemName(row)}</strong>
                      <span
                        ><i
                          class="systems-status-dot"
                          data-online=${row.environment.status === "available"}
                        ></i
                        >${systemStatus(row)}</span
                      >
                      <small
                        >${row.environment.platform ?? row.node?.platform ?? t("systems.unknown")} ·
                        ${t(row.environment.desktop ? "systems.desktop" : "systems.headless")}</small
                      >
                    </span>
                  </button>`,
                )}
              </section>`
            : nothing;
        })}
        ${!controller.loading && rows.length === 0 ? html`<p class="systems-sidebar__empty">${t(query ? "systems.noMatches" : "systems.empty")}</p>` : nothing}
      </div>
    </section>`;
  }
}

if (!customElements.get("openclaw-systems-sidebar")) {
  customElements.define("openclaw-systems-sidebar", SystemsSidebar);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-systems-sidebar": SystemsSidebar;
  }
}
