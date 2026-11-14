import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { registerSessionMenuEnglish } from "../i18n/locales/en-session-menu.ts";
import { EDITOR_IDS, EDITOR_LABELS } from "../lib/editor-links.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  type KeyboardShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { formatSessionSnoozeWakeTime, isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { useSessionMenuAppearance } from "./session-icon-picker-solid.tsx";
import type {
  SessionMenuActions,
  SessionManagementActionKind,
  SessionMenuActionsState as MenuState,
} from "./session-menu-actions.ts";
import type { CompactSessionMenuView } from "./session-menu-compact.ts";
import { useSessionMenuDetails } from "./session-menu-details-solid.tsx";
import { useSessionSnoozeEntries } from "./session-menu-snooze.tsx";
import { HeaderSearch } from "./solid/header-search.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "./solid/kbd.tsx";
import type { MenuControls, MenuEntry, MenuItem } from "./solid/menu.tsx";

registerSessionMenuEnglish();

export function SessionMenuShortcut(props: { shortcut: string; alias?: KeyboardShortcutCombo }) {
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

const GROUP_SEARCH_MIN_COUNT = 8;

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
  const archiveShortcut = () =>
    state.archiveShortcut && state.selectionCount === 1 && !state.session.archived
      ? KEYBOARD_SHORTCUT_COMBOS.archiveSession
      : undefined;
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
  const communicationDivider = separator("communication-divider");
  const involvementDivider = separator("involvement-divider");
  const deleteDivider = separator("delete-divider");
  const groupActionsDivider = separator("group-actions-divider");
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
        alias={entry.kind === "toggle-archived" ? archiveShortcut() : undefined}
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
        "session-menu__list-submenu":
          !state.compact &&
          (entry.view === "assign-owner" || entry.view === "group" || entry.view === "collections"),
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
      closeOnSelect: false,
      onBeforeShow:
        entry.view === "icon" || entry.view === "group" ? () => prepareView(entry.view) : undefined,
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
  const [groupQuery, setGroupQuery] = createSignal("");
  // Each opening starts from the full list.
  function prepareView(view: CompactSessionMenuView) {
    if (view === "group") {
      setGroupQuery("");
    } else if (view === "icon") {
      appearance.prepare();
    }
  }
  const groupSearchEntry: MenuEntry = content(
    "groups-search",
    <div
      class="people-menu__search session-menu__group-search"
      ref={nativeListener("click", (event) => event.stopPropagation())}
    >
      <HeaderSearch
        label={t("sessionsView.searchGroups")}
        query={groupQuery()}
        controlRef={() => options.controls?.ref()}
        inputProps={{ "data-search": "", "data-form-control": "" }}
        onQueryChange={setGroupQuery}
      />
    </div>,
  );
  function groupOptions(): MenuEntry[] {
    const terms = groupQuery().trim().toLocaleLowerCase().normalize("NFC").split(/\s+/u);
    const groups = state.groups.filter((group) =>
      terms.every((term) => group.toLocaleLowerCase().normalize("NFC").includes(term)),
    );
    const choices = groups.map((group) => ({
      label: group,
      value: `move-to-group:${encodeURIComponent(group)}`,
      checked: state.session.category === group,
      radio: true,
    }));
    const commands = [
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
    const row = (entry: (typeof choices)[number]): MenuEntry => {
      const kind = entry.value === "new-group" ? "new-group" : "move-to-group";
      return {
        id: entry.value,
        label: entry.label,
        class: "session-menu__item",
        type: entry.radio ? "radio" : undefined,
        checked: entry.checked,
        disabled: actions.actionDisabled(kind),
        attributes: { title: state.actionDisabledReasons[kind] },
        content: <span class="session-menu__text">{entry.label}</span>,
        details:
          entry.radio && entry.checked ? (
            <span class="session-menu__check" aria-hidden="true">
              <Icon name="check" />
            </span>
          ) : undefined,
      };
    };
    return [
      // Short lists stay plain; search appears once the list can scroll.
      ...(state.groups.length > GROUP_SEARCH_MIN_COUNT ? [groupSearchEntry] : []),
      ...(groups.length || !state.groups.length
        ? choices.map(row)
        : [
            content(
              "groups-empty",
              <div class="people-menu__status" role="status">
                {t("sessionsView.noGroupsMatch")}
              </div>,
            ),
          ]),
      ...(state.groups.length ? [groupActionsDivider] : []),
      ...commands.map(row),
    ];
  }
  const items = (kinds: readonly (keyof typeof STANDARD_ITEMS)[]) =>
    kinds.map((kind) =>
      item({ kind, label: t(STANDARD_ITEMS[kind][0]), icon: STANDARD_ITEMS[kind][1] }),
    );
  function body(view: CompactSessionMenuView): MenuEntry[] {
    switch (view) {
      case "advanced": {
        const involvementEntries = state.involvingMeContext ? [] : involvement();
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
          communicationDivider,
          ...details.communication(),
          details.readStatus,
          ...(involvementEntries.length ? [involvementDivider, ...involvementEntries] : []),
          deleteDivider,
          deleteAction(),
        ];
      }
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
      case "collections":
        return [
          ...actions.personalGroups.map((group): MenuItem => ({
            id: "personal-collection:" + group.id,
            label: group.label,
            class: "session-menu__item",
            labelClass: "session-menu__text",
            disabled: state.disabled || group.sessionKeys.includes(state.session.target?.key ?? ""),
            icon: icon("layers"),
          })),
          {
            id: "personal-collection:new",
            label: t("sessionsView.personalGroupNew"),
            class: "session-menu__item",
            labelClass: "session-menu__text",
            disabled: state.disabled,
            icon: icon("plus"),
          },
        ];
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
    ...(!batch() &&
    (state.navigationAllowed || state.splitAllowed || state.worktreePath || options.openInExtra)
      ? [
          submenu({
            view: "open-in",
            label: t("sessionsView.openInEditorMenu"),
            icon: "externalLink",
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
      ...(actions.collectionTarget
        ? [
            submenu({
              view: "collections",
              label: t("sessionsView.personalGroupAdd"),
              icon: "layers",
              disabled: state.disabled,
            }),
          ]
        : []),
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
      id: view === "icon" || view === "copy" ? "compact:back-advanced" : "compact:back",
      label: t("common.back"),
      class: "session-menu__item session-menu__back",
      icon: icon("arrowLeft"),
      closeOnSelect: false,
    },
    backDivider,
    ...body(view),
  ];
  return { appearance, prepareView, primary, organization, advanced, deleteAction, compact };
}
