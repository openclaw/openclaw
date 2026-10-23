import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { prefValuesEqual } from "../app/server-prefs-state.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { useApplication, useOptionalApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { readSessionDragData, sessionDragActive } from "../lib/sessions/drag.ts";
import {
  normalizePersonalSessionGroups,
  type PersonalSessionGroup,
} from "../lib/sessions/personal-groups.ts";
import { showToast } from "../lib/toast.ts";
import type { SidebarSessionListHost } from "./app-sidebar-session-render-types.ts";
import { renderSessionTree as SessionTree } from "./app-sidebar-session-row-render.tsx";
import { showPersonalSessionGroupDialog } from "./personal-session-group-dialog.tsx";
import { Icon } from "./solid/icon.tsx";
import { Menu } from "./solid/menu.tsx";

registerEnglishCatalog(registerSessionOrganizationEnglish);

const GROUP_DRAG_TYPE = "application/x-openclaw-personal-session-group";

/** Personal navigation owns these references; no session/group RPC participates. */
export function PersonalSessionGroups(props: { host: SidebarSessionListHost }) {
  const context = useOptionalApplication();
  return (
    <Show when={Boolean(context)}>
      <PersonalGroups host={props.host} />
    </Show>
  );
}

function PersonalGroups(props: { host: SidebarSessionListHost }) {
  const context = useApplication();
  const lifetime = new AbortController();
  onSettled(() => () => lifetime.abort());
  const navigation = projectOwner(context.navigation, (owner) => owner.snapshot);
  const groups = createMemo(() => navigation.read().personalSessionGroups ?? []);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);
  const write = (next: readonly PersonalSessionGroup[]): string | null => {
    // The profile preference has a byte limit. Never silently truncate an authored layout.
    if (!prefValuesEqual(normalizePersonalSessionGroups(next), next)) {
      return t("sessionsView.personalGroupCapacity");
    }
    context.navigation.update({ personalSessionGroups: next });
    return null;
  };
  const resolve = (key: string) =>
    props.host.resolvePersonalGroupSession
      ? props.host.resolvePersonalGroupSession(key)
      : props.host.reconciledSidebarZone().sessionRows.get(key);
  const visibleRows = (group: PersonalSessionGroup) => props.host.personalGroupSessionRows(group);
  const edit = async (id?: string) => {
    const scope = context.sessions.captureConnectionScope();
    if (!scope) {
      return;
    }
    const current = () => context.sessions.isConnectionScopeCurrent(scope);
    const controller = new AbortController();
    const stop = context.gateway.subscribe(() => {
      if (!current()) {
        controller.abort();
      }
    });
    try {
      if (!current()) {
        return;
      }
      const group = id ? groups().find((item) => item.id === id) : undefined;
      if (id && !group) {
        return;
      }
      const candidates = [...props.host.reconciledSidebarZone().sessionRows.values()].filter(
        (row) => row.pinnable && !row.archived,
      );
      await showPersonalSessionGroupDialog({
        group,
        candidates,
        signal: AbortSignal.any([controller.signal, lifetime.signal]),
        submit: (value) => {
          const saved = id ? groups().find((item) => item.id === id) : undefined;
          if (!current() || (id && !saved)) {
            return t("sessionsView.personalGroupUnavailable");
          }
          if (id && !prefValuesEqual(saved, group)) {
            return t("sessionsView.personalGroupChanged");
          }
          // Retain unresolved saved references, but new membership must still resolve.
          const previousKeys = new Set(group?.sessionKeys);
          const next = {
            ...value,
            id: id ?? crypto.randomUUID(),
            sessionKeys: value.sessionKeys.filter(
              (key) => previousKeys.has(key) || resolve(key)?.pinnable,
            ),
          };
          return write(
            id ? groups().map((item) => (item.id === id ? next : item)) : [...groups(), next],
          );
        },
      });
    } catch {
      showToast({ message: t("sessionsView.actionUnavailable") });
    } finally {
      stop();
    }
  };
  const move = (id: string, offset: number) => {
    const next = [...groups()];
    const from = next.findIndex((group) => group.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= next.length) {
      return;
    }
    const [group] = next.splice(from, 1);
    next.splice(to, 0, group!);
    write(next);
  };
  const drop = (event: DragEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const sourceId = event.dataTransfer?.getData(GROUP_DRAG_TYPE);
    if (sourceId) {
      const from = groups().findIndex((group) => group.id === sourceId);
      const to = groups().findIndex((group) => group.id === id);
      if (from >= 0 && to >= 0) {
        move(sourceId, to - from);
      }
      return;
    }
    const key = readSessionDragData(event.dataTransfer);
    const row = key ? resolve(key) : undefined;
    if (!key || !row?.pinnable || row.archived) {
      return;
    }
    const group = groups().find((candidate) => candidate.id === id);
    if (!group || group.sessionKeys.includes(key)) {
      return;
    }
    const updated = { ...group, sessionKeys: [...group.sessionKeys, key] };
    const error = write(groups().map((candidate) => (candidate.id === id ? updated : candidate)));
    if (error) {
      showToast({ message: error });
    }
    props.host.sessionOrganizer.finishSessionDrag();
  };
  return (
    <div class="sidebar-recent-sessions personal-session-groups">
      <div class="sidebar-recent-sessions__head personal-session-groups__heading">
        <span class="sidebar-session-group-status sidebar-recent-sessions__label-text">
          {t("sessionsView.personalGroups")}
        </span>
        <button
          type="button"
          class="sidebar-session-toolbar__button"
          aria-label={t("sessionsView.personalGroupNew")}
          title={t("sessionsView.personalGroupNew")}
          disabled={!props.host.connected || Boolean(props.host.sidebarSnapshot)}
          onClick={() => void edit()}
        >
          <Icon name="plus" />
        </button>
      </div>
      <For each={groups()} keyed={(group) => group.id}>
        {(group, index) => (
          <div
            class={[
              "sidebar-recent-sessions__group",
              {
                "sidebar-recent-sessions__group--session-drop": dropTarget() === group().id,
              },
            ]}
            data-personal-session-group={group().id}
            onDragOver={(event: DragEvent) => {
              if (
                sessionDragActive(event.dataTransfer) ||
                event.dataTransfer?.types.includes(GROUP_DRAG_TYPE)
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) {
                  event.dataTransfer.dropEffect = "move";
                }
                setDropTarget(group().id);
              }
            }}
            onDragLeave={(event: DragEvent) => {
              if (
                !(
                  event.relatedTarget instanceof Node &&
                  event.currentTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
              ) {
                setDropTarget(null);
              }
            }}
            onDrop={(event: DragEvent) => drop(event, group().id)}
          >
            <div
              class="sidebar-recent-sessions__head sidebar-recent-sessions__head--draggable personal-session-groups__header"
              draggable="true"
              onDragStart={(event: DragEvent) => {
                if (event.dataTransfer) {
                  event.dataTransfer.setData(GROUP_DRAG_TYPE, group().id);
                  event.dataTransfer.effectAllowed = "move";
                }
                event.stopPropagation();
              }}
              onDragEnd={() => setDropTarget(null)}
            >
              <button
                type="button"
                class="sidebar-session-group-toggle"
                aria-expanded={
                  props.host.collapsedPersonalSessionGroups.has(group().id) ? "false" : "true"
                }
                onClick={() => props.host.togglePersonalSessionGroup(group().id)}
              >
                <span class="sidebar-session-group-toggle__lead sidebar-session-group-toggle__icon">
                  <Icon
                    name={
                      props.host.collapsedPersonalSessionGroups.has(group().id)
                        ? "chevronRight"
                        : "chevronDown"
                    }
                  />
                </span>
                <span class="sidebar-recent-sessions__label-text">{group().label}</span>
              </button>
              <Menu
                id={`personal-group-${group().id}`}
                label={t("sessionsView.personalGroupOptions", { group: group().label })}
                trigger={<Icon name="moreHorizontal" />}
                triggerClass="sidebar-session-toolbar__button"
                panelClass="session-menu"
                items={[
                  { id: "edit", label: t("sessionsView.personalGroupEditMenu") },
                  {
                    id: "up",
                    label: t("sessionsView.personalGroupMoveUp"),
                    disabled: index() === 0,
                  },
                  {
                    id: "down",
                    label: t("sessionsView.personalGroupMoveDown"),
                    disabled: index() === groups().length - 1,
                  },
                  { id: "remove", label: t("sessionsView.personalGroupRemove"), variant: "danger" },
                ]}
                onSelect={(item) => {
                  if (item.id === "edit") {
                    void edit(group().id);
                  } else if (item.id === "remove") {
                    write(groups().filter((candidate) => candidate.id !== group().id));
                    showToast({ message: t("sessionsView.personalGroupRemoved") });
                  } else {
                    move(group().id, item.id === "up" ? -1 : 1);
                  }
                }}
              />
            </div>
            <Show when={!props.host.collapsedPersonalSessionGroups.has(group().id)}>
              <div role="list" aria-label={group().label} class="sidebar-recent-sessions__list">
                <For each={visibleRows(group())} keyed={(row) => row.key}>
                  {(row) => <SessionTree host={props.host} session={row()} />}
                </For>
              </div>
              <Show when={visibleRows(group()).length === 0}>
                <p class="sidebar-session-empty-hint">{t("sessionsView.personalGroupEmpty")}</p>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
