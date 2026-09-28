import { t } from "../i18n/index.ts";
import type { IconName } from "./icons.ts";

// A leaf module: the session menu imports these rules, so nothing here may import the menu.

/** Single-session menu actions that also run outside the menu, from the command palette. */
export type SessionCommandKind =
  | "toggle-pin"
  | "rename"
  | "toggle-unread"
  | "toggle-archived"
  | "fork"
  | "delete";

export type SessionCommand = { kind: SessionCommandKind; label: string; icon: IconName };

type SessionCommandState = {
  session: {
    pinnable?: boolean;
    isChild?: boolean;
    pinned: boolean;
    unread: boolean;
    archived: boolean;
    archiving?: boolean;
  };
  selectionCount: number;
  actionDisabledReasons: Partial<Record<SessionCommandKind, string>>;
  forkDisabled: boolean;
  archiveAllowed: boolean;
  deleteAllowed: boolean;
};

/** Menu rules beyond Gateway access; the session menu applies the same ones. */
export function sessionCommandUnavailable(
  kind: SessionCommandKind,
  state: SessionCommandState,
): boolean {
  const { session } = state;
  const batch = state.selectionCount > 1;
  switch (kind) {
    case "toggle-pin":
      return batch || session.pinnable === false || session.isChild === true || session.archived;
    case "rename":
      return batch;
    case "fork":
      return batch || state.forkDisabled;
    case "toggle-archived":
      return session.archiving === true || (!batch && !session.archived && !state.archiveAllowed);
    case "delete":
      return !state.deleteAllowed;
    case "toggle-unread":
      return false;
    default:
      return kind satisfies never;
  }
}

/** The menu's enabled single-session commands, with its labels and order. */
export function availableSessionCommands(state: SessionCommandState): SessionCommand[] {
  const { session } = state;
  const commands: SessionCommand[] = [
    {
      kind: "toggle-pin",
      label: t(session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession"),
      icon: session.pinned ? "pinOff" : "pin",
    },
    { kind: "rename", label: t("sessionsView.renameSession"), icon: "edit" },
    {
      kind: "toggle-unread",
      label: t(session.unread ? "sessionsView.markRead" : "sessionsView.markUnread"),
      icon: session.unread ? "eye" : "circle",
    },
    {
      kind: "toggle-archived",
      label: t(session.archived ? "sessionsView.restoreSession" : "sessionsView.archiveSession"),
      icon: session.archived ? "archiveRestore" : "archive",
    },
    { kind: "fork", label: t("sessionsView.forkSession"), icon: "copy" },
    { kind: "delete", label: t("sessionsView.deleteSession"), icon: "trash" },
  ];
  return commands.filter(
    ({ kind }) => !state.actionDisabledReasons[kind] && !sessionCommandUnavailable(kind, state),
  );
}
