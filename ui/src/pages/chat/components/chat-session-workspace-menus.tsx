import { createMemo, createUniqueId, Show } from "solid-js";
import type { SessionFilesDisplay } from "../../../app/settings-contract.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SessionWorkspaceFilter } from "./chat-sidebar-content-types.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

export function ActivityMenu(props: {
  workspace: SessionWorkspaceProps;
  filters: readonly SessionWorkspaceFilter[];
  filter: SessionWorkspaceFilter;
}) {
  const id = createUniqueId();
  const label = (filter: SessionWorkspaceFilter) =>
    filter === "all"
      ? t("chat.workspaceFiles.filterAll")
      : filter === "artifacts"
        ? t("chat.workspaceFiles.desktop.sessionFiles")
        : t(`chat.workspaceFiles.${filter}`);
  return (
    <Show
      when={
        props.filters.length > 1 &&
        (props.workspace.presentation === undefined || !props.workspace.navigation?.searchOpen)
      }
    >
      <div class="session-panel-rail__group">
        <Menu
          id={`workspace-activity-${id}`}
          label={`${t("chat.workspaceFiles.filters")}: ${label(props.filter)}`}
          class="workspace-desktop__activity-menu"
          panelClass="workspace-desktop__menu"
          triggerClass="session-panel-rail__button session-panel-rail__button--labelled"
          trigger={
            <>
              <span>{label(props.filter)}</span>
              <Icon name="chevronDown" class="session-panel-rail__chevron" />
            </>
          }
          items={props.filters.map((filter) => ({
            id: filter,
            label: label(filter),
            type: "radio",
            checked: props.filter === filter,
            icon:
              filter === "all" ? (
                // Lucide files, the approved activity glyph (ISC).
                <StrokeIcon aria-hidden="true">
                  <path d="M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
                  <path d="M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z" />
                  <path d="M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1" />
                </StrokeIcon>
              ) : (
                <Icon
                  name={
                    filter === "read" ? "eye" : filter === "artifacts" ? "paperclip" : "fileDiff"
                  }
                />
              ),
          }))}
          onSelect={(item) => {
            const filter = props.filters.find((candidate) => candidate === item.id);
            if (filter) {
              props.workspace.onSetFilter(filter);
            }
          }}
        />
      </div>
    </Show>
  );
}

export function SessionFilesDisplayMenu(props: {
  display: SessionFilesDisplay;
  onChange: (display: Partial<SessionFilesDisplay>) => void;
}) {
  const id = createUniqueId();
  const views = [
    ["list", "list", "viewList"],
    ["grid", "layoutGrid", "viewGrid"],
  ] as const;
  const sorts = [
    ["default", "sortDefault"],
    ["date", "sortDate"],
    ["name", "sortName"],
    ["type", "sortType"],
  ] as const;
  const heading = (key: "view" | "sortBy") => (
    <div class="oc-menu-heading">
      <span class="oc-menu-heading__label">{t(`chat.workspaceFiles.display.${key}`)}</span>
    </div>
  );
  // Entries hold JSX; build them under this owner, not inside the menu's lazy reads.
  const items = createMemo<MenuEntry[]>(() => [
    { kind: "content", id: "view-heading", content: heading("view") },
    ...views.map(([view, icon, key]) => ({
      id: `view:${view}`,
      label: t(`chat.workspaceFiles.display.${key}`),
      type: "radio" as const,
      checked: props.display.view === view,
      icon: <Icon name={icon} />,
    })),
    { kind: "content", id: "sort-separator", content: <div role="separator" /> },
    { kind: "content", id: "sort-heading", content: heading("sortBy") },
    ...sorts.map(([sort, key]) => ({
      id: `sort:${sort}`,
      label: t(`chat.workspaceFiles.display.${key}`),
      type: "radio" as const,
      checked: props.display.sort === sort,
    })),
  ]);
  return (
    <Menu
      id={`workspace-session-display-${id}`}
      label={t("chat.workspaceFiles.display.label")}
      panelClass="workspace-desktop__menu"
      triggerClass="session-panel-rail__button"
      triggerAttributes={{ title: t("chat.workspaceFiles.display.label") }}
      trigger={<Icon name={props.display.view === "grid" ? "layoutGrid" : "list"} />}
      items={items()}
      onSelect={(item) => {
        const view = views.find(([candidate]) => item.id === `view:${candidate}`)?.[0];
        const sort = sorts.find(([candidate]) => item.id === `sort:${candidate}`)?.[0];
        if (view) {
          props.onChange({ view });
        } else if (sort) {
          props.onChange({ sort });
        }
      }}
    />
  );
}
