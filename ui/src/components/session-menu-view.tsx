import { createMemo, For, Match, Show, Switch } from "solid-js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS } from "../lib/editor-links.ts";
import { formatTimeMs } from "../lib/format.ts";
import {
  formatSessionSnoozeWakeTime,
  isSessionSnoozed,
  resolveSessionSnoozePresets,
} from "../lib/sessions/session-snooze.ts";
import { useSessionMenuAppearance } from "./session-icon-picker-solid.tsx";
import type {
  SessionMenuActions,
  SessionManagementActionKind,
  SessionMenuActionsState as MenuState,
} from "./session-menu-actions.ts";
import type { CompactSessionMenuView } from "./session-menu-compact.ts";
import { useSessionMenuDetails } from "./session-menu-details-solid.tsx";
import { SessionMenuItem } from "./session-menu-item.tsx";
import { sessionArchiveShortcut } from "./session-menu-options.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "./solid/kbd.tsx";

export function SessionMenuShortcut(props: {
  shortcut: string;
  alias?: ReturnType<typeof sessionArchiveShortcut>;
}) {
  return (
    <span slot="details" class="session-menu__shortcut" aria-hidden="true">
      <Kbd keys={props.shortcut.toUpperCase()} inline />
      {props.alias ? (
        <>
          {" "}
          / <KeyboardShortcut combo={props.alias} inline />
        </>
      ) : undefined}
    </span>
  );
}

type Inline = { inline?: boolean };
type ItemProps = Inline & {
  kind: SessionManagementActionKind;
  label: string;
  icon: IconName;
  shortcut?: string;
  title?: string;
};
type SubmenuProps = Inline & {
  view: Exclude<CompactSessionMenuView, "root">;
  label: string;
  icon: IconName;
  disabled?: boolean;
  title?: string;
};

export function useSessionMenuView(
  host: HTMLElement,
  actions: SessionMenuActions,
  readState: () => MenuState,
  revision: () => number,
) {
  const state = readState();
  const batch = () => state.selectionCount > 1;
  const count = () => String(state.selectionCount);
  const disabled = (kind: SessionManagementActionKind) =>
    actions.actionDisabled(kind, actions.actionExtraDisabled(kind));
  const appearance = useSessionMenuAppearance(
    host,
    readState,
    (kind) => actions.actionDisabled(kind),
    (action) => actions.runAction(action),
  );
  const { OwnerStatus, OwnerOptions, Communication, error } = useSessionMenuDetails(
    actions,
    readState,
    disabled,
    revision,
  );
  const multipleOwners = createMemo(() => {
    revision();
    return actions.ownerMenu.multipleOwners;
  });
  const involvementAvailable = createMemo(() => {
    revision();
    return actions.involvementAvailable;
  });

  const Item = (props: ItemProps) => (
    <SessionMenuItem
      slot={props.inline === false ? "submenu" : undefined}
      class={["session-menu__item", { "session-menu__item--destructive": props.kind === "delete" }]}
      variant={props.kind === "delete" ? "danger" : "default"}
      value={props.kind}
      data-shortcut={props.shortcut}
      aria-keyshortcuts={props.shortcut?.toUpperCase()}
      data-new-tab-action={
        props.kind === "open-new-tab" || props.kind === "open-new-window" ? "" : undefined
      }
      disabled={disabled(props.kind)}
      title={state.actionDisabledReasons[props.kind] ?? props.title}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">
        <Icon name={props.icon} />
      </span>
      <span class="session-menu__text">{props.label}</span>
      <Show when={props.shortcut}>
        <SessionMenuShortcut
          shortcut={props.shortcut ?? ""}
          alias={props.kind === "toggle-archived" ? sessionArchiveShortcut(state) : undefined}
        />
      </Show>
    </SessionMenuItem>
  );

  const Submenu = (props: SubmenuProps) => {
    const shortcut = () =>
      props.view === "archive" ? "a" : !state.compact && props.view === "icon" ? "i" : undefined;
    return (
      <SessionMenuItem
        slot={props.inline === false ? "submenu" : undefined}
        class={[
          "session-menu__item",
          {
            "session-menu__item--compact-details": state.compact && props.view === "archive",
            "people-menu__submenu": !state.compact && props.view === "assign-owner",
            "session-menu__advanced": !state.compact && props.view === "advanced",
          },
        ]}
        value={state.compact ? `compact:open-${props.view}` : undefined}
        disabled={props.disabled}
        title={props.title}
        data-shortcut={shortcut()}
        aria-keyshortcuts={shortcut()?.toUpperCase()}
        onSubmenu-opening={(event) => {
          if (props.view === "icon") {
            appearance.focusOnOpen(event);
          }
        }}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">
          <Icon name={props.icon} />
        </span>
        <span class="session-menu__text">{props.label}</span>
        <Show when={shortcut()}>
          <Show when={state.compact} fallback={<SessionMenuShortcut shortcut={shortcut() ?? ""} />}>
            <span class="session-menu__compact-details" aria-hidden="true">
              <SessionMenuShortcut
                shortcut={shortcut() ?? ""}
                alias={sessionArchiveShortcut(state)}
              />
            </span>
          </Show>
        </Show>
        <Show when={state.compact} fallback={<Body view={props.view} />}>
          <span slot="details" class="session-menu__icon session-menu__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </Show>
      </SessionMenuItem>
    );
  };

  const Archive = (props: Inline & { choice?: boolean }) => (
    <Show
      when={!props.choice && !batch() && state.session.hasChildren && !state.session.archived}
      fallback={
        <Item
          kind="toggle-archived"
          label={t(
            state.session.archiving
              ? "sessionsView.archiving"
              : batch()
                ? state.session.archived
                  ? "sessionsView.restoreSessionCount"
                  : "sessionsView.archiveSessionCount"
                : state.session.archived
                  ? "sessionsView.restoreSession"
                  : props.choice
                    ? "sessionsView.archiveSessionOnly"
                    : "sessionsView.archiveSession",
            { count: count() },
          )}
          icon={state.session.archived ? "archiveRestore" : "archive"}
          inline={props.inline}
          shortcut="a"
        />
      }
    >
      <Submenu
        view="archive"
        label={t(
          state.session.archiving ? "sessionsView.archiving" : "sessionsView.archiveSession",
        )}
        icon="archive"
        disabled={disabled("toggle-archived")}
        title={state.actionDisabledReasons["toggle-archived"]}
      />
    </Show>
  );

  const Involvement = (props: Inline) => (
    <Show
      when={involvementAvailable() && !batch() && state.session.hiddenFromInvolvingMe !== undefined}
    >
      <Item
        kind="toggle-involving-me"
        label={t(
          state.session.hiddenFromInvolvingMe
            ? "sessionsView.showInInvolvingMe"
            : "sessionsView.hideFromInvolvingMe",
        )}
        icon={state.session.hiddenFromInvolvingMe ? "eye" : "eyeOff"}
        inline={props.inline}
      />
    </Show>
  );
  const DeleteAction = (props: Inline) => (
    <Item
      kind="delete"
      label={t(batch() ? "sessionsView.deleteSessionCount" : "sessionsView.deleteSessionMenu", {
        count: count(),
      })}
      icon="trash"
      inline={props.inline}
      shortcut="d"
    />
  );

  const GroupOptions = (props: Inline) => {
    const entries = createMemo(() => [
      ...state.groups.map((group) => ({
        label: group,
        value: `move-to-group:${encodeURIComponent(group)}`,
        checked: state.session.category === group,
        radio: true,
      })),
      ...(state.session.category
        ? [
            {
              label: t(
                state.session.categoryClearReturnsToGroups
                  ? "sessionsView.moveBackToGroups"
                  : "sessionsView.removeFromGroup",
              ),
              value: "move-to-group:",
              checked: false,
              radio: false,
            },
          ]
        : []),
      { label: t("sessionsView.newGroup"), value: "new-group", checked: false, radio: false },
    ]);
    return (
      <For each={entries()} keyed={(entry) => entry.value}>
        {(entry, index) => {
          const kind = (): "new-group" | "move-to-group" =>
            entry().value === "new-group" ? "new-group" : "move-to-group";
          const shortcut = () => (index() < 9 ? String(index() + 1) : undefined);
          return (
            <SessionMenuItem
              class="session-menu__item"
              slot={props.inline ? undefined : "submenu"}
              value={entry().value}
              checked={entry().radio ? entry().checked : undefined}
              data-shortcut={shortcut()}
              aria-keyshortcuts={shortcut()}
              disabled={actions.actionDisabled(kind())}
              title={state.actionDisabledReasons[kind()]}
            >
              <span class="session-menu__text">{entry().label}</span>
              <Show when={entry().radio && entry().checked}>
                <span slot="details" class="session-menu__check" aria-hidden="true">
                  <Icon name="check" />
                </span>
              </Show>
              <Show when={shortcut()}>
                <SessionMenuShortcut shortcut={shortcut() ?? ""} />
              </Show>
            </SessionMenuItem>
          );
        }}
      </For>
    );
  };

  const SnoozeOptions = (props: Inline) => {
    const now = new Date();
    const presets = resolveSessionSnoozePresets(now);
    const labels = {
      hour: "sessionsView.snoozeHour",
      "three-hours": "sessionsView.snoozeThreeHours",
      evening: "sessionsView.snoozeEvening",
      tomorrow: "sessionsView.snoozeTomorrow",
      "next-week": "sessionsView.snoozeNextWeek",
    } as const;
    return (
      <For each={presets}>
        {(preset) => (
          <SessionMenuItem
            class="session-menu__item"
            slot={props.inline ? undefined : "submenu"}
            value={`snooze:${preset.snoozedUntil}`}
            disabled={actions.actionDisabled("snooze")}
            title={state.actionDisabledReasons.snooze}
          >
            <span class="session-menu__text">
              {t(labels[preset.id])} ·{" "}
              {preset.id === "next-week"
                ? formatSessionSnoozeWakeTime(preset.snoozedUntil, now)
                : formatTimeMs(preset.snoozedUntil)}
            </span>
          </SessionMenuItem>
        )}
      </For>
    );
  };

  const CopyOptions = (props: Inline) => (
    <>
      <Show when={state.navigationAllowed}>
        <Item
          kind="copy-session-preview-link"
          label={t("sessionsView.copySessionPreviewLink")}
          icon="link"
          inline={props.inline}
        />
      </Show>
      <Item
        kind="copy-markdown"
        label={t("sessionsView.copyMarkdown")}
        icon="fileText"
        inline={props.inline}
      />
      <Item
        kind="copy-session-id"
        label={t("sessionsView.copySessionId")}
        icon="copy"
        inline={props.inline}
      />
    </>
  );
  const OpenOptions = (props: Inline) => (
    <>
      <Show when={state.navigationAllowed}>
        <Item
          kind="open-new-tab"
          label={t("sessionsView.openNewTab")}
          icon="externalLink"
          inline={props.inline}
        />
        <Item
          kind="open-new-window"
          label={t("sessionsView.openNewWindow")}
          icon="monitor"
          inline={props.inline}
        />
      </Show>
      <Show when={state.splitAllowed}>
        <Item
          kind="split-right"
          label={t("chat.splitView.splitRight")}
          icon="columns2"
          inline={props.inline}
        />
        <Item
          kind="split-below"
          label={t("sessionsView.splitBelow")}
          icon="panelBottomOpen"
          inline={props.inline}
        />
      </Show>
      <Show when={state.worktreePath}>
        <div slot={props.inline ? undefined : "submenu"} class="session-menu__info">
          {t("sessionsView.workspaceEditors")}
        </div>
        <For each={EDITOR_IDS}>
          {(editor) => (
            <SessionMenuItem
              class="session-menu__item"
              slot={props.inline ? undefined : "submenu"}
              value={`open-in:${editor}`}
              disabled={actions.actionDisabled("open-in")}
            >
              <span class="session-menu__text">{EDITOR_LABELS[editor]}</span>
            </SessionMenuItem>
          )}
        </For>
      </Show>
    </>
  );

  const AdvancedBody = (props: Inline) => (
    <>
      <Submenu
        view="icon"
        label={t("sessionsView.setIconColorMenu")}
        icon="palette"
        disabled={actions.actionDisabled("set-icon") && actions.actionDisabled("set-color")}
        title={state.actionDisabledReasons["set-icon"] ?? state.actionDisabledReasons["set-color"]}
        inline={props.inline}
      />
      <Item
        kind="fork"
        label={t("sessionsView.forkSession")}
        icon="copy"
        inline={props.inline}
        shortcut="f"
        title={state.forkFromLastCompleted ? t("sessionsView.forkFromLastCompleted") : undefined}
      />
      <Submenu
        view="copy"
        label={t("sessionsView.copyDetails")}
        icon="copy"
        inline={props.inline}
      />
      <Show when={Boolean(state.navigationAllowed || state.worktreePath)}>
        <Submenu
          view="open-in"
          label={t("sessionsView.openInEditorMenu")}
          icon="externalLink"
          inline={props.inline}
        />
      </Show>
      <Communication inline={props.inline ?? false} />
      <Show when={error() !== null}>
        <div slot={props.inline ? undefined : "submenu"} class="session-menu__info" role="alert">
          {error()}
        </div>
        <SessionMenuItem
          class="session-menu__item"
          slot={props.inline ? undefined : "submenu"}
          value="reload-settings"
        >
          <span class="session-menu__text">{t("common.retry")}</span>
        </SessionMenuItem>
      </Show>
      <Show when={!state.involvingMeContext}>
        <Involvement inline={props.inline} />
      </Show>
      <div
        slot={props.inline ? undefined : "submenu"}
        class="session-menu__separator"
        role="separator"
      />
      <DeleteAction inline={props.inline} />
    </>
  );
  const Appearance = () => appearance.render(false);
  const InlineAppearance = () => appearance.render(true);
  const Body = (props: Inline & { view: CompactSessionMenuView }) => (
    <Switch>
      <Match when={props.view === "advanced"}>
        <AdvancedBody inline={props.inline ?? false} />
      </Match>
      <Match when={props.view === "archive"}>
        <Archive inline={props.inline ?? false} choice />
        <Item
          kind="archive-tree"
          label={t("sessionsView.archiveSessionTree")}
          icon="archive"
          inline={props.inline ?? false}
        />
      </Match>
      <Match when={props.view === "snooze"}>
        <SnoozeOptions inline={props.inline ?? false} />
      </Match>
      <Match when={props.view === "copy"}>
        <CopyOptions inline={props.inline ?? false} />
      </Match>
      <Match when={props.view === "open-in"}>
        <OpenOptions inline={props.inline ?? false} />
      </Match>
      <Match when={props.view === "icon"}>
        <Show when={props.inline} fallback={<Appearance />}>
          <InlineAppearance />
        </Show>
      </Match>
      <Match when={props.view === "group"}>
        <GroupOptions inline={props.inline ?? false} />
      </Match>
      <Match when={props.view === "assign-owner"}>
        <OwnerOptions inline={props.inline ?? false} />
      </Match>
    </Switch>
  );

  const Primary = () => (
    <>
      <Show when={!batch() && state.session.pinnable !== false && !state.session.isChild}>
        <Item
          kind="toggle-pin"
          label={t(state.session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession")}
          icon={state.session.pinned ? "pinOff" : "pin"}
          shortcut="p"
        />
      </Show>
      <Show when={!batch()}>
        <Item kind="rename" label={t("sessionsView.renameSessionMenu")} icon="edit" shortcut="r" />
      </Show>
      <Item
        kind="toggle-unread"
        label={t(
          batch()
            ? state.session.unread
              ? "sessionsView.markReadCount"
              : "sessionsView.markUnreadCount"
            : state.session.unread
              ? "sessionsView.markRead"
              : "sessionsView.markUnread",
          { count: count() },
        )}
        icon={state.session.unread ? "eye" : "circle"}
        shortcut="u"
      />
      <Show when={!batch() && state.navigationAllowed}>
        <Item
          kind="copy-session-link"
          label={t("sessionsView.copyLink")}
          icon="link"
          shortcut="c"
        />
      </Show>
      <Show when={batch()}>
        <Archive />
      </Show>
    </>
  );
  const Organization = () => (
    <>
      <Show when={!batch()}>
        <Show when={multipleOwners()} fallback={<OwnerStatus inline />}>
          <Submenu
            view="assign-owner"
            label={t("sessionsView.assignTo")}
            icon="users"
            disabled={actions.actionDisabled("assign-owner")}
            title={state.actionDisabledReasons["assign-owner"]}
          />
        </Show>
      </Show>
      <Submenu
        view="group"
        label={t(batch() ? "sessionsView.moveToGroupMenuCount" : "sessionsView.moveToGroupMenu", {
          count: count(),
        })}
        icon="folder"
        disabled={actions.actionDisabled("move-to-group")}
        title={state.actionDisabledReasons["move-to-group"]}
      />
      <Show when={!batch() && state.session.isChild}>
        <Item
          kind="move-to-top-level"
          label={t("sessionsView.moveToTopLevel")}
          icon="arrowUpRight"
        />
      </Show>
      <Show when={state.involvingMeContext}>
        <Involvement />
      </Show>
      <Show when={!batch()}>
        <Show when={!actions.actionExtraDisabled("snooze")}>
          <Show
            when={isSessionSnoozed(
              { snoozedUntil: state.session.snoozedUntil ?? undefined },
              Date.now(),
            )}
            fallback={
              <Submenu
                view="snooze"
                label={t("sessionsView.snooze")}
                icon="clock"
                disabled={actions.actionDisabled("snooze")}
                title={state.actionDisabledReasons.snooze}
              />
            }
          >
            <Item
              kind="wake"
              label={`${t("sessionsView.wakeSession")} · ${formatSessionSnoozeWakeTime(state.session.snoozedUntil!)}`}
              icon="clock"
            />
          </Show>
        </Show>
        <Archive />
      </Show>
    </>
  );
  const Advanced = () => (
    <Submenu view="advanced" label={t("sessionsView.advanced")} icon="settings" />
  );
  const Compact = (props: { view: CompactSessionMenuView }) => (
    <>
      <SessionMenuItem
        class="session-menu__item session-menu__back"
        value={
          props.view === "icon" || props.view === "copy" || props.view === "open-in"
            ? "compact:back-advanced"
            : "compact:back"
        }
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">
          <Icon name="arrowLeft" />
        </span>
        <span class="session-menu__text">{t("common.back")}</span>
      </SessionMenuItem>
      <div class="session-menu__separator" role="separator" />
      <Body view={props.view} inline />
    </>
  );
  return { appearance, Primary, Organization, Advanced, DeleteAction, Compact };
}
