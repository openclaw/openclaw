import { Errored, For, Loading, Show, createMemo, createUniqueId, latest } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuEntry, type MenuItem } from "../../components/solid/menu.tsx";
import { registerSystemsEnglish } from "../../i18n/locales/en-systems.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import type { SystemsInventoryRow } from "./systems-data.ts";
import { createSystemsRead } from "./systems-read.ts";
import type { Systems, SystemsSortMode, SystemsStatusFilter } from "./systems-state.ts";
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

type SystemsSidebarProps = { controller?: Systems };
function SystemsSidebarContent(props: SystemsSidebarProps) {
  const projection = createMemo(() =>
    props.controller ? projectOwner(props.controller, (value) => value) : null,
  );
  const controller = () => projection()?.read();
  return (
    <Show when={controller()?.current()}>
      <SystemsInventory controller={controller()!} />
    </Show>
  );
}
function SystemsInventory(props: { controller: Systems }) {
  const menuId = createUniqueId();
  const controller = () => props.controller;
  const inventoryRead = createSystemsRead(() => controller().inventoryRead);
  const readStatus = () => {
    latest(inventoryRead.read);
    return null;
  };
  const query = createMemo(() =>
    controller().state.query.trim().toLocaleLowerCase().normalize("NFC"),
  );
  const rows = createMemo(() => {
    const sortMode = controller().state.sortMode;
    return controller()
      .state.rows.filter((row) => {
        const matchesStatus =
          controller().state.statusFilter === "all" ||
          row.environment.status ===
            (controller().state.statusFilter === "online" ? "available" : "unavailable");
        return (
          matchesStatus &&
          [
            systemName(row),
            row.environment.id,
            systemPlatform(row) ?? "",
            row.environment.platform ?? row.node?.platform ?? "",
          ].some((value) => value.toLocaleLowerCase().normalize("NFC").includes(query()))
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
  const filterItem = (
    prefix: "sort" | "status",
    option: { value: string; labelKey: string },
    checked: boolean,
  ): MenuItem => ({
    id: `${prefix}:${option.value}`,
    label: t(option.labelKey),
    type: "radio",
    checked,
    class: "sidebar-session-sort-menu__item",
    content: <span class="session-menu__text">{t(option.labelKey)}</span>,
    details: (
      <span class="session-menu__check" aria-hidden="true">
        {checked ? <Icon name="check" /> : null}
      </span>
    ),
  });
  const filterItems = createMemo((): readonly MenuEntry[] => [
    {
      kind: "content",
      id: "sort-heading",
      content: <div class="sidebar-session-sort-menu__title">{t("systems.sortBy")}</div>,
    },
    ...sortOptions.map((option) =>
      filterItem("sort", option, controller().state.sortMode === option.value),
    ),
    {
      kind: "content",
      id: "status-heading",
      content: (
        <>
          <div class="session-menu__separator" role="separator" />
          <div class="sidebar-session-sort-menu__title">{t("systems.status")}</div>
        </>
      ),
    },
    ...statusOptions.map((option) =>
      filterItem("status", option, controller().state.statusFilter === option.value),
    ),
  ]);
  const renderRow = (row: SystemsInventoryRow) => {
    const online = row.environment.status === "available";
    const platform = systemPlatform(row);
    const status = () => systemStatus(row);
    return (
      <button
        class="systems-machine"
        type="button"
        data-status={row.environment.status}
        aria-pressed={row.environment.id === controller().state.selectedId ? "true" : "false"}
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
          value={controller().state.query}
          onInput={(event) => controller().updatePresentation({ query: event.currentTarget.value })}
        />
        <Menu
          id={menuId}
          class="systems-filter-menu"
          panelClass="sidebar-session-sort-menu"
          placement="bottom-end"
          label={t("systems.filterSort")}
          triggerClass={[
            "systems-filter__sort sidebar-session-sort",
            { "sidebar-session-sort--filtered": controller().state.statusFilter !== "all" },
          ]}
          triggerAttributes={{ title: t("systems.filterSort") }}
          trigger={<Icon name="listFilter" />}
          items={filterItems()}
          onSelect={(item) => {
            const value = item.id;
            const sort = sortOptions.find((option) => value === `sort:${option.value}`);
            const status = statusOptions.find((option) => value === `status:${option.value}`);
            if (sort) {
              controller().updatePresentation({ sortMode: sort.value });
            } else if (status) {
              controller().updatePresentation({ statusFilter: status.value });
            }
          }}
        />
        <button
          type="button"
          class="systems-filter__refresh"
          aria-label={t("systems.refresh")}
          title={t("systems.refresh")}
          disabled={inventoryRead.pending() || !controller().connected()}
          onClick={() => void controller().refresh("manual")}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <Show when={inventoryRead.receipt()} keyed>
        {(receipt) => (
          <Errored fallback={null}>
            <Loading on={receipt}>{readStatus()}</Loading>
          </Errored>
        )}
      </Show>
      <div class="systems-sidebar__list" aria-busy={inventoryRead.pending() ? "true" : "false"}>
        {inventoryRead.pending() && !controller().state.inventory ? (
          <p class="systems-sidebar__empty" role="status">
            {t("systems.loading")}
          </p>
        ) : null}
        <For each={rows().filter((row) => systemKind(row) === "host")}>{renderRow}</For>
        <For each={["node", "worker"] as const}>
          {(kind) => {
            const group = createMemo(() => rows().filter((row) => systemKind(row) === kind));
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
        {!inventoryRead.pending() && rows().length === 0 ? (
          <p class="systems-sidebar__empty">
            {t(
              query() || controller().state.statusFilter !== "all"
                ? "systems.noMatches"
                : "systems.empty",
            )}
          </p>
        ) : null}
      </div>
    </section>
  );
}

defineSolidBridge<SystemsSidebarProps>("openclaw-systems-sidebar", SystemsSidebarContent, {
  properties: { controller: { default: undefined, attribute: false } },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-systems-sidebar": SolidBridgeElement<SystemsSidebarProps>;
  }
}
