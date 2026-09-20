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
  const named =
    row.gatewaySystemInfo?.machineName ?? row.environment.label ?? row.node?.displayName;
  if (named) {
    return named;
  }
  if (row.environment.id === "gateway") {
    return t("systems.host");
  }
  const worker = row.environment.worker;
  if (worker) {
    // A worker is best known by the session placed on it; otherwise by its
    // provider profile, matching the chat placement label.
    const placed = row.sessions.find((relation) => relation.kind === "placement")?.session;
    if (placed) {
      return placed.displayName ?? placed.label ?? placed.key;
    }
    if (worker.profileId) {
      return `${worker.providerId} · ${worker.profileId}`;
    }
  }
  return row.environment.id;
}

/** Short, stable fragment of a Gateway-owned id for telling same-profile workers apart. */
function shortId(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1, id.lastIndexOf(":") + 7);
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
    const renderRow = (row: SystemsInventoryRow) => {
      const online = row.environment.status === "available";
      const platform = row.environment.platform ?? row.node?.platform;
      const status = systemStatus(row);
      return html`<button
        class="systems-machine"
        type="button"
        data-status=${row.environment.status}
        aria-pressed=${row.environment.id === controller.selectedId}
        title=${platform ? `${status} · ${platform}` : status}
        @click=${() => controller.select(row.environment.id)}
      >
        <i class="systems-machine__dot" aria-hidden="true"></i>
        <span class="systems-machine__name">${systemName(row)}</span>
        <span class="systems-machine__meta"
          >${!online ? status : row.environment.worker ? shortId(row.environment.id) : (platform ?? nothing)}</span
        >
        ${
          row.environment.desktop
            ? html`<span class="systems-machine__desktop" title=${t("systems.desktop")}
                >${icons.monitor}<span class="sr-only">${t("systems.desktop")}</span></span
              >`
            : nothing
        }
      </button>`;
    };
    return html`<section class="systems-sidebar" aria-label=${t("systems.inventory")}>
      <div class="systems-filter">
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
        <button
          type="button"
          class="systems-filter__refresh"
          aria-label=${t("systems.refresh")}
          title=${t("systems.refresh")}
          ?disabled=${controller.loading || !controller.connected}
          @click=${() => void controller.refresh()}
        >
          ${icons.refresh}
        </button>
      </div>
      <div class="systems-sidebar__list" aria-busy=${controller.loading}>
        ${controller.loading && !controller.inventory ? html`<p class="systems-sidebar__empty" role="status">${t("systems.loading")}</p>` : nothing}
        ${rows.filter((row) => systemKind(row) === "host").map(renderRow)}
        ${(["node", "worker"] as const).map((kind) => {
          const group = rows.filter((row) => systemKind(row) === kind);
          return group.length
            ? html`<section class="systems-group">
                <h3>
                  <span>${t(kind === "node" ? "systems.nodes" : "systems.workers")}</span>
                  <span class="systems-group__count">${group.length}</span>
                </h3>
                ${group.map(renderRow)}
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
