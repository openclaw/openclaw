import { For, Show, createEffect, createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import type {
  SystemsController,
  SystemsSortMode,
  SystemsStatusFilter,
} from "./systems-controller.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import "../../styles/systems.css";

registerEnglishCatalog(registerSystemsEnglish);

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

function MenuOption(props: { value: string; label: string; checked: boolean }) {
  let item!: HTMLElement;
  createEffect(
    () => props.checked,
    (checked) => {
      syncDropdownItemRadio(item, checked);
    },
  );
  return (
    <wa-dropdown-item
      class="sidebar-session-sort-menu__item"
      value={props.value}
      role="menuitemradio"
      aria-checked={props.checked ? "true" : "false"}
      ref={(element) => {
        item = element;
      }}
    >
      <span class="session-menu__text">{t(props.label)}</span>
      <span slot="details" class="session-menu__check" aria-hidden="true">
        {props.checked ? <Icon name="check" /> : null}
      </span>
    </wa-dropdown-item>
  );
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

type SystemsSidebarProps = { controller?: SystemsController };
type SystemsSidebarElement = SolidBridgeElement<SystemsSidebarProps>;
function SystemsSidebarContent(props: SystemsSidebarProps) {
  const projection = createMemo(() =>
    props.controller
      ? projectSource(props.controller, {
          read: (value) => value,
          subscribe: (value, notify) => value.subscribe(notify),
          equality: "revision",
        })
      : null,
  );
  const controller = () => projection()?.read();
  return (
    <Show when={controller()?.current}>
      <SystemsInventory controller={controller()!} />
    </Show>
  );
}
function SystemsInventory(props: { controller: SystemsController }) {
  const controller = () => props.controller;
  const query = () => controller().query.trim().toLocaleLowerCase();
  const rows = createMemo(() => {
    const sortMode = controller().sortMode;
    return controller()
      .rows.filter((row) => {
        const matchesStatus =
          controller().statusFilter === "all" ||
          row.environment.status ===
            (controller().statusFilter === "online" ? "available" : "unavailable");
        return (
          matchesStatus &&
          [
            systemName(row),
            row.environment.id,
            systemPlatform(row) ?? "",
            row.environment.platform ?? row.node?.platform ?? "",
          ].some((value) => value.toLocaleLowerCase().includes(query()))
        );
      })
      .toSorted((a, b) => {
        if (sortMode !== "name") {
          const firstStatus = sortMode === "online-first" ? "available" : "unavailable";
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
  });
  const renderRow = (row: SystemsInventoryRow) => {
    const online = row.environment.status === "available";
    const platform = systemPlatform(row);
    const status = () => systemStatus(row);
    return (
      <button
        class="systems-machine"
        type="button"
        data-status={row.environment.status}
        aria-pressed={row.environment.id === controller().selectedId ? "true" : "false"}
        aria-description={platform ? `${status()} · ${platform}` : status()}
        onClick={() => controller().select(row.environment.id)}
      >
        <i class="systems-machine__dot" aria-hidden="true" />
        <span class="systems-machine__name">{systemName(row)}</span>
        <span class="systems-machine__meta">
          {!online
            ? status()
            : row.environment.worker
              ? shortId(row.environment.id)
              : (platform ?? null)}
        </span>
        {row.environment.desktop ? (
          <span class="systems-machine__desktop">
            <Icon name="monitor" />
            <span class="sr-only">{t("systems.desktop")}</span>
          </span>
        ) : null}
      </button>
    );
  };
  return (
    <section class="systems-sidebar" aria-label={t("systems.inventory")}>
      <div class="systems-filter">
        <span aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          type="search"
          aria-label={t("systems.search")}
          placeholder={t("systems.search")}
          value={controller().query}
          onInput={(event: InputEvent) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              controller().updatePresentation({ query: event.currentTarget.value });
            }
          }}
        />
        <wa-dropdown
          class="systems-filter-menu sidebar-session-sort-menu"
          placement="bottom-end"
          aria-label={t("systems.filterSort")}
          onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
            const value = event.detail.item.value;
            const sort = sortOptions.find((option) => value === `sort:${option.value}`);
            const status = statusOptions.find((option) => value === `status:${option.value}`);
            if (sort) {
              controller().updatePresentation({ sortMode: sort.value });
            } else if (status) {
              controller().updatePresentation({ statusFilter: status.value });
            }
          }}
        >
          <button
            slot="trigger"
            type="button"
            class={[
              "systems-filter__sort sidebar-session-sort",
              { "sidebar-session-sort--filtered": controller().statusFilter !== "all" },
            ]}
            aria-label={t("systems.filterSort")}
            title={t("systems.filterSort")}
          >
            <Icon name="listFilter" />
          </button>
          <div class="sidebar-session-sort-menu__title">{t("systems.sortBy")}</div>
          <For each={sortOptions}>
            {(option) => (
              <MenuOption
                value={`sort:${option.value}`}
                label={option.labelKey}
                checked={controller().sortMode === option.value}
              />
            )}
          </For>
          <div class="session-menu__separator" role="separator" />
          <div class="sidebar-session-sort-menu__title">{t("systems.status")}</div>
          <For each={statusOptions}>
            {(option) => (
              <MenuOption
                value={`status:${option.value}`}
                label={option.labelKey}
                checked={controller().statusFilter === option.value}
              />
            )}
          </For>
        </wa-dropdown>
        <button
          type="button"
          class="systems-filter__refresh"
          aria-label={t("systems.refresh")}
          title={t("systems.refresh")}
          disabled={controller().loading || !controller().connected}
          onClick={() => void controller().refresh("manual")}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div class="systems-sidebar__list" aria-busy={controller().loading ? "true" : "false"}>
        {controller().loading && !controller().inventory ? (
          <p class="systems-sidebar__empty" role="status">
            {t("systems.loading")}
          </p>
        ) : null}
        <For each={rows().filter((row) => systemKind(row) === "host")}>{renderRow}</For>
        <For each={["node", "worker"] as const}>
          {(kind) => {
            const group = () => rows().filter((row) => systemKind(row) === kind);
            return (
              <Show when={group().length}>
                <section class="systems-group">
                  <h3>
                    <span>{t(kind === "node" ? "systems.nodes" : "systems.workers")}</span>
                    <span class="systems-group__count">{group().length}</span>
                  </h3>
                  <For each={group()}>{renderRow}</For>
                </section>
              </Show>
            );
          }}
        </For>
        {!controller().loading && rows().length === 0 ? (
          <p class="systems-sidebar__empty">
            {t(
              query() || controller().statusFilter !== "all"
                ? "systems.noMatches"
                : "systems.empty",
            )}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export const SystemsSidebar = defineSolidBridge<SystemsSidebarProps>(
  "openclaw-systems-sidebar",
  SystemsSidebarContent,
  {
    properties: { controller: { default: undefined, attribute: false } },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-systems-sidebar": SystemsSidebarElement;
  }
}
