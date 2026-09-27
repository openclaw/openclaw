import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type {
  SystemsController,
  SystemsSortMode,
  SystemsStatusFilter,
} from "./systems-controller.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import "../../styles/systems.css";

registerSystemsEnglish();

const sortOptions = [
  { value: "name", labelKey: "systems.alphabetical" },
  { value: "online-first", labelKey: "systems.onlineFirst" },
  { value: "offline-first", labelKey: "systems.offlineFirst" },
] as const satisfies ReadonlyArray<{ value: SystemsSortMode; labelKey: string }>;
const statusOptions = [
  { value: "all", labelKey: "systems.all" },
  { value: "online", labelKey: "systems.online" },
  { value: "offline", labelKey: "systems.offline" },
] as const satisfies ReadonlyArray<{ value: SystemsStatusFilter; labelKey: string }>;

function renderMenuOption(value: string, label: string, checked: boolean) {
  return html`<wa-dropdown-item
    class="sidebar-session-sort-menu__item"
    value=${value}
    role="menuitemradio"
    aria-checked=${String(checked)}
    ${ref((element) => syncDropdownItemRadio(element, checked))}
  >
    <span class="session-menu__text">${t(label)}</span>
    <span slot="details" class="session-menu__check" aria-hidden="true"
      >${checked ? icons.check : nothing}</span
    >
  </wa-dropdown-item>`;
}

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

export function systemPlatform(row: SystemsInventoryRow): string | undefined {
  const platform = row.gatewaySystemInfo?.osLabel ?? row.environment.platform ?? row.node?.platform;
  return platform ? prettifyPlatform(platform, row.node?.deviceFamily) : undefined;
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
    const rows = controller.rows
      .filter((row) => {
        const matchesStatus =
          controller.statusFilter === "all" ||
          row.environment.status ===
            (controller.statusFilter === "online" ? "available" : "unavailable");
        return (
          matchesStatus &&
          [
            systemName(row),
            row.environment.id,
            systemPlatform(row) ?? "",
            row.environment.platform ?? row.node?.platform ?? "",
          ].some((value) => value.toLocaleLowerCase().includes(query))
        );
      })
      .toSorted((a, b) => {
        if (controller.sortMode !== "name") {
          const firstStatus = controller.sortMode === "online-first" ? "available" : "unavailable";
          const statusOrder =
            Number(b.environment.status === firstStatus) -
            Number(a.environment.status === firstStatus);
          if (statusOrder) {
            return statusOrder;
          }
        }
        return (
          systemName(a).localeCompare(systemName(b), undefined, {
            numeric: true,
            sensitivity: "base",
          }) || a.environment.id.localeCompare(b.environment.id)
        );
      });
    const renderRow = (row: SystemsInventoryRow) => {
      const online = row.environment.status === "available";
      const platform = systemPlatform(row);
      const status = systemStatus(row);
      return html`<button
        class="systems-machine"
        type="button"
        data-status=${row.environment.status}
        aria-pressed=${row.environment.id === controller.selectedId}
        aria-description=${platform ? `${status} · ${platform}` : status}
        @click=${() => controller.select(row.environment.id)}
      >
        <i class="systems-machine__dot" aria-hidden="true"></i>
        <span class="systems-machine__name">${systemName(row)}</span>
        <span class="systems-machine__meta"
          >${!online ? status : row.environment.worker ? shortId(row.environment.id) : (platform ?? nothing)}</span
        >
        ${
          row.environment.desktop
            ? html`<span class="systems-machine__desktop"
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
        <wa-dropdown
          class="systems-filter-menu sidebar-session-sort-menu"
          placement="bottom-end"
          aria-label=${t("systems.filterSort")}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const value = event.detail.item.value;
            const sort = sortOptions.find((option) => value === `sort:${option.value}`);
            const status = statusOptions.find((option) => value === `status:${option.value}`);
            if (sort) {
              controller.setSortMode(sort.value);
            } else if (status) {
              controller.setStatusFilter(status.value);
            }
          }}
        >
          <button
            slot="trigger"
            type="button"
            class="systems-filter__sort sidebar-session-sort ${controller.statusFilter !== "all" ? "sidebar-session-sort--filtered" : ""}"
            aria-label=${t("systems.filterSort")}
            title=${t("systems.filterSort")}
          >
            ${icons.listFilter}
          </button>
          <div class="sidebar-session-sort-menu__title">${t("systems.sortBy")}</div>
          ${sortOptions.map((option) => renderMenuOption(`sort:${option.value}`, option.labelKey, controller.sortMode === option.value))}
          <div class="session-menu__separator" role="separator"></div>
          <div class="sidebar-session-sort-menu__title">${t("systems.status")}</div>
          ${statusOptions.map((option) => renderMenuOption(`status:${option.value}`, option.labelKey, controller.statusFilter === option.value))}
        </wa-dropdown>
        <button
          type="button"
          class="systems-filter__refresh"
          aria-label=${t("systems.refresh")}
          title=${t("systems.refresh")}
          ?disabled=${controller.loading || !controller.connected}
          @click=${() => void controller.refresh("manual")}
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
        ${!controller.loading && rows.length === 0 ? html`<p class="systems-sidebar__empty">${t(query || controller.statusFilter !== "all" ? "systems.noMatches" : "systems.empty")}</p>` : nothing}
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
