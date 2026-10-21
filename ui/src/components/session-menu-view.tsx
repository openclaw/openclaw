import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { EDITOR_IDS, EDITOR_LABELS } from "../lib/editor-links.ts";
import { t } from "../lib/reactive/i18n.ts";
import { formatSessionSnoozeWakeTime, isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import { useSessionMenuAppearance } from "./session-icon-picker-solid.tsx";
import type {
  SessionMenuActions,
  SessionManagementActionKind,
  SessionMenuActionsState as MenuState,
} from "./session-menu-actions.ts";
import type { CompactSessionMenuView } from "./session-menu-compact.ts";
import { useSessionMenuDetails } from "./session-menu-details-solid.tsx";
import { sessionArchiveShortcut } from "./session-menu-options.ts";
import { useSessionSnoozeEntries } from "./session-menu-snooze.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "./solid/kbd.tsx";
import type { MenuControls, MenuEntry, MenuItem } from "./solid/menu.tsx";

export function SessionMenuShortcut(props: {
  shortcut: string;
  alias?: ReturnType<typeof sessionArchiveShortcut>;
}) {
  return (
    <span class="session-menu__shortcut" aria-hidden="true">
      <Kbd keys={props.shortcut.toUpperCase()} inline />
      <Show when={props.alias} keyed>
        {(alias) => (
          <>
            {" "}
            / <KeyboardShortcut combo={alias} inline />
          </>
        )}
      </Show>
    </span>
  );
}

type ItemOptions = {
  kind: SessionManagementActionKind;
  label: string;
  icon: IconName;
  shortcut?: string;
  title?: string;
};
type SubmenuOptions = {
  view: Exclude<CompactSessionMenuView, "root">;
  label: string;
  icon: IconName;
  disabled?: boolean;
  title?: string;
};

const STANDARD_ITEMS = {
  "copy-session-preview-link": ["sessionsView.copySessionPreviewLink", "link"],
  "copy-markdown": ["sessionsView.copyMarkdown", "fileText"],
  "copy-session-id": ["sessionsView.copySessionId", "copy"],
  "open-new-tab": ["sessionsView.openNewTab", "externalLink"],
  "open-new-window": ["sessionsView.openNewWindow", "monitor"],
  "split-right": ["chat.splitView.splitRight", "columns2"],
  "split-below": ["sessionsView.splitBelow", "panelBottomOpen"],
} as const;

export function useSessionMenuEntries(
  actions: SessionMenuActions,
  readState: () => MenuState,
  options: { openInExtra?: () => readonly MenuEntry[]; controls?: MenuControls } = {},
) {
  const state = readState();
  const batch = () => state.selectionCount > 1;
  const count = () => String(state.selectionCount);
  const disabled = (kind: SessionManagementActionKind) =>
    actions.actionDisabled(kind, actions.actionExtraDisabled(kind));
  const appearance = useSessionMenuAppearance(
    readState,
    (kind) => actions.actionDisabled(kind),
    (action) => actions.runAction(action),
    options.controls?.ref,
  );
  const details = useSessionMenuDetails(actions, readState, disabled, options.controls);
  const multipleOwners = actions.ownerMenu.multipleOwners;
  const involvementAvailable = createMemo(() => actions.involvementAvailable);
  const appearanceContent = createMemo(() => appearance.render(), { lazy: true });
  const snoozeEntries = createMemo(() => useSessionSnoozeEntries(actions, readState), {
    lazy: true,
  });
  const icon = (name: IconName) => (
    <span class="session-menu__icon" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
  const content = (id: string, value: JSX.Element): MenuEntry => ({
    kind: "content",
    id,
    content: value,
  });
  const separator = (id: string) =>
    content(id, <div class="session-menu__separator" role="separator" />);
  const deleteDivider = separator("delete-divider");
  const item = (entry: ItemOptions): MenuItem => ({
    id: entry.kind,
    label: entry.label,
    class: ["session-menu__item", { "session-menu__item--destructive": entry.kind === "delete" }],
    variant: entry.kind === "delete" ? "danger" : undefined,
    disabled: disabled(entry.kind),
    attributes: {
      title: state.actionDisabledReasons[entry.kind] ?? entry.title,
      "data-shortcut": entry.shortcut,
      "aria-keyshortcuts": entry.shortcut?.toUpperCase(),
      "data-new-tab-action":
        entry.kind === "open-new-tab" || entry.kind === "open-new-window" ? "" : undefined,
    },
    icon: icon(entry.icon),
    content: <span class="session-menu__text">{entry.label}</span>,
    details: entry.shortcut ? (
      <SessionMenuShortcut
        shortcut={entry.shortcut}
        alias={entry.kind === "toggle-archived" ? sessionArchiveShortcut(state) : undefined}
      />
    ) : undefined,
  });
  const submenu = (entry: SubmenuOptions): MenuItem => {
    const shortcut = !state.compact && entry.view === "icon" ? "i" : undefined;
    return {
      id: state.compact ? `compact:open-${entry.view}` : `submenu:${entry.view}`,
      label: entry.label,
      labelClass: "session-menu__text",
      class: {
        "session-menu__item": true,
        "people-menu__submenu": !state.compact && entry.view === "assign-owner",
        "session-menu__advanced": !state.compact && entry.view === "advanced",
      },
      disabled: entry.disabled,
      attributes: {
        title: entry.title,
        "data-shortcut": shortcut,
        "aria-keyshortcuts": shortcut?.toUpperCase(),
      },
      icon: icon(entry.icon),
      details: (
        <>
          {shortcut ? <SessionMenuShortcut shortcut={shortcut} /> : undefined}
          {state.compact ? (
            <span class="session-menu__icon session-menu__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          ) : undefined}
        </>
      ),
      children: state.compact ? undefined : () => body(entry.view),
      prewarm: entry.view === "assign-owner",
      closeOnSelect: false,
      onBeforeShow: entry.view === "icon" ? appearance.prepare : undefined,
    };
  };
  const archive = (): MenuItem =>
    item({
      kind: "toggle-archived",
      label: t(
        state.session.archiving
          ? "sessionsView.archiving"
          : batch()
            ? state.session.archived
              ? "sessionsView.restoreSessionCount"
              : "sessionsView.archiveSessionCount"
            : state.session.archived
              ? "sessionsView.restoreSession"
              : "sessionsView.archiveSession",
        { count: count() },
      ),
      icon: state.session.archived ? "archiveRestore" : "archive",
      shortcut: "a",
    });
  const involvement = (): MenuEntry[] =>
    involvementAvailable() && !batch() && state.session.hiddenFromInvolvingMe !== undefined
      ? [
          item({
            kind: "toggle-involving-me",
            label: t(
              state.session.hiddenFromInvolvingMe
                ? "sessionsView.showInInvolvingMe"
                : "sessionsView.hideFromInvolvingMe",
            ),
            icon: state.session.hiddenFromInvolvingMe ? "eye" : "eyeOff",
          }),
        ]
      : [];
  const deleteAction = () =>
    item({
      kind: "delete",
      label: t(batch() ? "sessionsView.deleteSessionCount" : "sessionsView.deleteSessionMenu", {
        count: count(),
      }),
      icon: "trash",
      shortcut: "d",
    });
  function groupOptions(): MenuEntry[] {
    const entries = [
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
    ];
    return entries.map((entry, index) => {
      const kind = entry.value === "new-group" ? "new-group" : "move-to-group";
      const shortcut = index < 9 ? String(index + 1) : undefined;
      return {
        id: entry.value,
        label: entry.label,
        class: "session-menu__item",
        type: entry.radio ? "radio" : undefined,
        checked: entry.checked,
        disabled: actions.actionDisabled(kind),
        attributes: {
          title: state.actionDisabledReasons[kind],
          "data-shortcut": shortcut,
          "aria-keyshortcuts": shortcut,
        },
        content: <span class="session-menu__text">{entry.label}</span>,
        details: (
          <>
            {entry.radio && entry.checked ? (
              <span class="session-menu__check" aria-hidden="true">
                <Icon name="check" />
              </span>
            ) : undefined}
            {shortcut ? <SessionMenuShortcut shortcut={shortcut} /> : undefined}
          </>
        ),
      };
    });
  }
  const items = (kinds: readonly (keyof typeof STANDARD_ITEMS)[]) =>
    kinds.map((kind) =>
      item({ kind, label: t(STANDARD_ITEMS[kind][0]), icon: STANDARD_ITEMS[kind][1] }),
    );
  function body(view: CompactSessionMenuView): MenuEntry[] {
    switch (view) {
      case "advanced":
        return [
          submenu({
            view: "icon",
            label: t("sessionsView.setIconColorMenu"),
            icon: "palette",
            disabled: actions.actionDisabled("set-icon") && actions.actionDisabled("set-color"),
            title:
              state.actionDisabledReasons["set-icon"] ?? state.actionDisabledReasons["set-color"],
          }),
          item({
            kind: "fork",
            label: t("sessionsView.forkSession"),
            icon: "copy",
            shortcut: "f",
            title: state.forkFromLastCompleted
              ? t("sessionsView.forkFromLastCompleted")
              : undefined,
          }),
          submenu({ view: "copy", label: t("sessionsView.copyDetails"), icon: "copy" }),
          ...(state.navigationAllowed || state.worktreePath || options.openInExtra
            ? [
                submenu({
                  view: "open-in",
                  label: t("sessionsView.openInEditorMenu"),
                  icon: "externalLink",
                }),
              ]
            : []),
          ...details.communication(),
          ...(details.error() !== null
            ? [
                content(
                  "settings-error",
                  <div class="session-menu__info" role="alert">
                    {details.error()}
                  </div>,
                ),
                { id: "reload-settings", label: t("common.retry"), class: "session-menu__item" },
              ]
            : []),
          ...(!state.involvingMeContext ? involvement() : []),
          deleteDivider,
          deleteAction(),
        ];
      case "snooze":
        return snoozeEntries()();
      case "copy":
        return [
          ...(state.navigationAllowed ? items(["copy-session-preview-link"]) : []),
          ...items(["copy-markdown", "copy-session-id"]),
        ];
      case "open-in":
        return [
          ...(state.navigationAllowed ? items(["open-new-tab", "open-new-window"]) : []),
          ...(state.splitAllowed ? items(["split-right", "split-below"]) : []),
          ...(options.openInExtra?.() ?? []),
          ...(state.worktreePath
            ? [
                content(
                  "editors-heading",
                  <div class="session-menu__info">{t("sessionsView.workspaceEditors")}</div>,
                ),
                ...EDITOR_IDS.map((editor) => ({
                  id: `open-in:${editor}`,
                  label: EDITOR_LABELS[editor],
                  class: "session-menu__item",
                  disabled: actions.actionDisabled("open-in"),
                })),
              ]
            : []),
        ];
      case "icon":
        return [content("appearance", appearanceContent())];
      case "group":
        return groupOptions();
      case "assign-owner":
        return details.ownerOptions();
      case "root":
        break;
    }
    return [];
  }
  const primary = (): MenuEntry[] => [
    ...(!batch() && state.session.pinnable !== false && !state.session.isChild
      ? [
          item({
            kind: "toggle-pin",
            label: t(
              state.session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession",
            ),
            icon: state.session.pinned ? "pinOff" : "pin",
            shortcut: "p",
          }),
        ]
      : []),
    ...(!batch()
      ? [
          item({
            kind: "rename",
            label: t("sessionsView.renameSessionMenu"),
            icon: "edit",
            shortcut: "r",
          }),
        ]
      : []),
    item({
      kind: "toggle-unread",
      label: t(
        batch()
          ? state.session.unread
            ? "sessionsView.markReadCount"
            : "sessionsView.markUnreadCount"
          : state.session.unread
            ? "sessionsView.markRead"
            : "sessionsView.markUnread",
        { count: count() },
      ),
      icon: state.session.unread ? "eye" : "circle",
      shortcut: "u",
    }),
    ...(!batch() && state.navigationAllowed
      ? [
          item({
            kind: "copy-session-link",
            label: t("sessionsView.copyLink"),
            icon: "link",
            shortcut: "c",
          }),
        ]
      : []),
    ...(!batch() && state.session.placementAction
      ? [
          item({
            kind: "move-session",
            label: t(
              state.session.placementAction === "dispatch"
                ? "sessionsView.moveToCloud"
                : state.session.placementAction === "retry"
                  ? "sessionsView.retrySessionMove"
                  : "sessionsView.moveSession",
            ),
            icon: "cloud",
          }),
        ]
      : []),
    ...(batch() ? [archive()] : []),
  ];
  function organization(): MenuEntry[] {
    return [
      ...(!batch()
        ? multipleOwners()
          ? [
              submenu({
                view: "assign-owner",
                label: t("sessionsView.assignTo"),
                icon: "users",
                disabled: actions.actionDisabled("assign-owner"),
                title: state.actionDisabledReasons["assign-owner"],
              }),
            ]
          : details.ownerStatus()
        : []),
      submenu({
        view: "group",
        label: t(batch() ? "sessionsView.moveToGroupMenuCount" : "sessionsView.moveToGroupMenu", {
          count: count(),
        }),
        icon: "folder",
        disabled: actions.actionDisabled("move-to-group"),
        title: state.actionDisabledReasons["move-to-group"],
      }),
      ...(!batch() && state.session.isChild
        ? [
            item({
              kind: "move-to-top-level",
              label: t("sessionsView.moveToTopLevel"),
              icon: "arrowUpRight",
            }),
          ]
        : []),
      ...(state.involvingMeContext ? involvement() : []),
      ...(!batch() && !actions.actionExtraDisabled("snooze")
        ? [
            isSessionSnoozed({ snoozedUntil: state.session.snoozedUntil ?? undefined }, Date.now())
              ? item({
                  kind: "wake",
                  label: `${t("sessionsView.wakeSession")} · ${formatSessionSnoozeWakeTime(state.session.snoozedUntil!)}`,
                  icon: "clock",
                })
              : submenu({
                  view: "snooze",
                  label: t("sessionsView.snooze"),
                  icon: "clock",
                  disabled: actions.actionDisabled("snooze"),
                  title: state.actionDisabledReasons.snooze,
                }),
          ]
        : []),
      ...(!batch() ? [archive()] : []),
    ];
  }
  const advanced = () => [
    submenu({ view: "advanced", label: t("sessionsView.advanced"), icon: "settings" }),
  ];
  const backDivider = separator("back-divider");
  const compact = (view: CompactSessionMenuView): MenuEntry[] => [
    {
      id:
        view === "icon" || view === "copy" || view === "open-in"
          ? "compact:back-advanced"
          : "compact:back",
      label: t("common.back"),
      class: "session-menu__item session-menu__back",
      icon: icon("arrowLeft"),
      closeOnSelect: false,
    },
    backDivider,
    ...body(view),
  ];
  return { appearance, primary, organization, advanced, deleteAction, compact };
}
