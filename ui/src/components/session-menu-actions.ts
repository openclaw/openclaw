import type { GatewaySessionRow } from "../api/types.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { registerSessionPlacementEnglish } from "../i18n/locales/en-session-placement.ts";
import { EDITOR_IDS, type EditorId } from "../lib/editor-links.ts";
import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { customSnoozeStorageKey, readCustomSnooze } from "../lib/sessions/custom-snooze.ts";
import type { SolidControllerHost } from "../lit/solid-controller-host.ts";
import type { SessionCommunicationMenuAction } from "./session-communication-options.ts";
import { SessionMenuSettings } from "./session-menu-settings.ts";
import type { SessionCreatedActor, SessionOwnerOption } from "./session-owner-chip.ts";
import { SessionOwnerMenu } from "./session-owner-menu.ts";
import "../styles/sidebar-menus.css";

registerSessionOrganizationEnglish();
registerSessionPlacementEnglish();

export type SessionMenuData = {
  label: string;
  placementAction?: "dispatch" | "move" | "retry";
  target?: { key: string; agentId?: string };
  sessionId: string | null;
  isChild?: boolean;
  hasChildren?: boolean;
  pinnable?: boolean;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  snoozedUntil: number | null;
  hiddenFromInvolvingMe?: boolean;
  communication?: GatewaySessionRow["communication"];
  effectiveCommunication?: GatewaySessionRow["effectiveCommunication"];
  archiving?: boolean;
  category: string | null;
  icon: string | null;
  color: string | null;
  categoryClearReturnsToGroups: boolean;
};

const SIMPLE_SESSION_ACTIONS = [
  "copy-session-id",
  "copy-session-link",
  "copy-session-preview-link",
  "copy-markdown",
  "open-new-tab",
  "open-new-window",
  "split-right",
  "split-below",
  "reset-appearance",
  "toggle-pin",
  "toggle-unread",
  "toggle-involving-me",
  "rename",
  "fork",
  "move-session",
  "new-group",
  "toggle-archived",
  "archive-tree",
  "move-to-top-level",
  "delete",
] as const;

export type SessionManagementAction =
  | {
      [Kind in (typeof SIMPLE_SESSION_ACTIONS)[number]]: { kind: Kind };
    }[(typeof SIMPLE_SESSION_ACTIONS)[number]]
  | { kind: "open-in"; editor: EditorId; path: string }
  | SessionCommunicationMenuAction
  | { kind: "set-icon"; icon: string | null }
  | { kind: "set-color"; color: string | null }
  | { kind: "assign-owner"; owner: Pick<SessionOwnerOption, "type" | "id"> }
  | { kind: "move-to-group"; category: string | null }
  | { kind: "snooze"; snoozedUntil: number; rememberCustom?: boolean }
  | { kind: "wake" };

export type SessionManagementActionKind = SessionManagementAction["kind"];

export const EMPTY_SESSION_MENU_DATA: SessionMenuData = {
  label: "",
  sessionId: null,
  pinned: false,
  unread: false,
  archived: false,
  snoozedUntil: null,
  category: null,
  icon: null,
  color: null,
  categoryClearReturnsToGroups: false,
};

type SessionMenuActionsHost = SolidControllerHost & HTMLElement;

export type SessionMenuActionsState = {
  involvingMeContext?: boolean;
  session: SessionMenuData;
  selectionCount: number;
  compact: boolean;
  disabled: boolean;
  actionDisabledReasons: Partial<Record<SessionManagementActionKind, string>>;
  forkDisabled: boolean;
  forkFromLastCompleted: boolean;
  archiveAllowed: boolean;
  snoozeAllowed?: boolean;
  archiveShortcut?: boolean;
  deleteAllowed: boolean;
  groups: readonly string[];
  currentOwner: SessionCreatedActor | null;
  worktreePath: string | null;
  navigationAllowed: boolean;
  copyMarkdownAllowed: boolean;
  splitAllowed: boolean;
};

/** Canonical single-session actions shared by sidebar and chat-header menus. */
export class SessionMenuActions {
  private readonly context = useOptionalApplication();
  private readonly gateway = this.context ? projectGateway(this.context.gateway) : undefined;
  readonly ownerMenu: SessionOwnerMenu;
  readonly advanced;
  openCustomSnooze?: () => void;
  customSnoozeKeydown?: (event: KeyboardEvent) => boolean;

  get customSnoozeKey(): string | null {
    const client = this.gateway?.read().snapshot.client;
    return client ? customSnoozeStorageKey(client.gatewayUrl, client.recoveryScope) : null;
  }

  constructor(
    private readonly host: SessionMenuActionsHost,
    private readonly readState: () => SessionMenuActionsState,
    private readonly onAction: (action: SessionManagementAction) => void,
    private readonly onClose: () => void,
  ) {
    this.ownerMenu = new SessionOwnerMenu(host);
    this.advanced = new SessionMenuSettings(host, {
      context: () => this.context,
      readState: () => this.readState(),
      runAction: (action) => this.runAction(action),
    });
  }

  get involvementAvailable(): boolean {
    return (
      this.gateway?.read().snapshot.hello?.policy?.hasMultipleSessionSharingIdentities === true
    );
  }

  readonly loadOwners = () => {
    this.advanced.open();
    if (this.readState().selectionCount === 1) {
      this.ownerMenu.load();
    }
  };

  actionDisabled(kind: SessionManagementActionKind, extra = false): boolean {
    const state = this.readState();
    return state.disabled || extra || Boolean(state.actionDisabledReasons[kind]);
  }

  actionExtraDisabled(kind: SessionManagementActionKind): boolean {
    const state = this.readState();
    const { session } = state;
    const batch = state.selectionCount > 1;
    switch (kind) {
      case "open-in":
        return batch || !state.worktreePath;
      case "copy-session-link":
      case "copy-session-preview-link":
      case "open-new-tab":
      case "open-new-window":
        return batch || !state.navigationAllowed;
      case "copy-markdown":
        return batch || !state.copyMarkdownAllowed;
      case "split-right":
      case "split-below":
        return batch || !state.splitAllowed;
      case "reset-appearance":
        return batch || this.actionDisabled("set-icon") || this.actionDisabled("set-color");
      case "copy-session-id":
        return batch || !session.sessionId;
      case "toggle-pin":
        return batch || session.pinnable === false || session.isChild === true || session.archived;
      case "snooze":
      case "wake":
        return (
          !state.snoozeAllowed || this.actionExtraDisabled("toggle-pin") || !state.archiveAllowed
        );
      case "toggle-involving-me":
        return (
          !this.involvementAvailable ||
          batch ||
          session.hiddenFromInvolvingMe === undefined ||
          !session.sessionId
        );
      case "set-communication":
        return batch || !this.advanced.communicationAvailable;
      case "rename":
      case "set-icon":
      case "set-color":
      case "assign-owner":
        return batch;
      case "move-session":
        return batch || !session.placementAction || session.archived;
      case "fork":
        return batch || state.forkDisabled;
      case "move-to-group":
      case "new-group":
        return false;
      case "move-to-top-level":
        return batch || !session.isChild;
      case "archive-tree":
        return (
          batch ||
          !session.hasChildren ||
          session.archived ||
          session.archiving === true ||
          !state.archiveAllowed
        );
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

  runAction(action: SessionManagementAction): void {
    if (this.actionDisabled(action.kind, this.actionExtraDisabled(action.kind))) {
      return;
    }
    // Appearance edits share one persistent picker; all other actions dismiss it.
    if (
      action.kind !== "set-icon" &&
      action.kind !== "set-color" &&
      action.kind !== "reset-appearance"
    ) {
      this.onClose();
    }
    this.onAction(action);
  }

  handleSelect(value: string): boolean {
    if (this.advanced.handleSelect(value)) {
      return true;
    }
    if (value === "reload-owners") {
      this.ownerMenu.load();
      return true;
    }
    const kind = SIMPLE_SESSION_ACTIONS.find((candidate) => candidate === value);
    if (kind) {
      this.runAction({ kind });
      return true;
    }
    if (value === "snooze-reuse") {
      const snoozedUntil = readCustomSnooze(this.customSnoozeKey);
      if (snoozedUntil !== null) {
        this.runAction({ kind: "snooze", snoozedUntil });
      }
      return true;
    }
    if (value === "snooze-custom") {
      if (!this.actionDisabled("snooze", this.actionExtraDisabled("snooze"))) {
        this.openCustomSnooze?.();
      }
      return true;
    }
    if (value === "wake") {
      this.runAction({ kind: "wake" });
      return true;
    }
    if (value.startsWith("snooze:")) {
      const snoozedUntil = Number(value.slice("snooze:".length));
      if (Number.isFinite(snoozedUntil) && snoozedUntil > Date.now()) {
        this.runAction({ kind: "snooze", snoozedUntil });
      }
      return true;
    }
    if (value.startsWith("open-in:")) {
      const state = this.readState();
      const editor = EDITOR_IDS.find((candidate) => candidate === value.slice("open-in:".length));
      if (state.worktreePath && editor) {
        this.runAction({ kind: "open-in", editor, path: state.worktreePath });
      }
      return true;
    }
    if (value.startsWith("move-to-group:")) {
      const encodedCategory = value.slice("move-to-group:".length);
      this.runAction({
        kind: "move-to-group",
        category: encodedCategory ? decodeURIComponent(encodedCategory) : null,
      });
      return true;
    }
    const [action, type, encodedId] = value.split(":");
    if (action === "assign-owner" && (type === "human" || type === "agent") && encodedId) {
      this.runAction({ kind: "assign-owner", owner: { type, id: decodeURIComponent(encodedId) } });
      return true;
    }
    return false;
  }

  focusCurrentView(): void {
    void this.host.updateComplete.then(() => {
      const first =
        this.host.querySelector<HTMLElement>(".session-menu__appearance button:not(:disabled)") ??
        this.host.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])");
      first?.focus();
    });
  }

  handleKeydown(event: KeyboardEvent, appearancePicker: { showIconGrid: () => void }): boolean {
    if (this.customSnoozeKeydown?.(event)) {
      return true;
    }
    const target = event.composedPath().find((node) => node instanceof HTMLElement);
    const key = resolveAsciiShortcutKey(event);
    // Moving these actions into Advanced must not retire their existing menu shortcuts.
    const kind = key === "f" ? "fork" : key === "d" ? "delete" : undefined;
    if (
      kind &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.matches("input, textarea, select, [contenteditable=true]"),
        ) &&
      !this.actionDisabled(kind, this.actionExtraDisabled(kind))
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.runAction({ kind });
      return true;
    }
    const item = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.matches("wa-dropdown-item"),
      );
    if (event.key === "Tab" && !event.shiftKey && item) {
      const settings = item.parentElement;
      const picker = settings?.querySelector<HTMLElement>(":scope > .session-menu__communication");
      const first = picker?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (first) {
        // Menu arrows visit rows; Tab enters the embedded controls without dismissing.
        event.preventDefault();
        event.stopPropagation();
        first.focus();
        return true;
      }
    }
    const appearance = target?.closest<HTMLElement>(
      ".session-menu__appearance, .session-menu__communication",
    );
    if (event.key === "Tab" && target && appearance && this.host.contains(appearance)) {
      const controls = Array.from(
        appearance.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled)',
        ),
      ).filter((control) => !control.closest('[inert], [hidden], [aria-hidden="true"]'));
      const index = controls.indexOf(target);
      let next = index < 0 ? undefined : controls[index + (event.shiftKey ? -1 : 1)];
      if (
        index === 0 &&
        event.shiftKey &&
        appearance.classList.contains("session-menu__communication")
      ) {
        for (
          let previous = appearance.previousElementSibling;
          previous;
          previous = previous.previousElementSibling
        ) {
          if (
            previous instanceof HTMLElement &&
            previous.matches("wa-dropdown-item:not([disabled])")
          ) {
            next = previous;
            break;
          }
        }
      }
      if (next) {
        // Web Awesome dismisses on Tab. Embedded settings own internal
        // traversal; only its outer edges return to the menu's dismissal path.
        event.preventDefault();
        event.stopPropagation();
        next.focus();
        return true;
      }
      return false;
    }
    const input = event
      .composedPath()
      .find(
        (candidate): candidate is HTMLTextAreaElement =>
          candidate instanceof HTMLTextAreaElement &&
          candidate.classList.contains("session-menu__icon-custom-input"),
      );
    if (!input) {
      return false;
    }
    // The shared picker owns Enter, including IME confirmation and disabled input.
    if (event.key === "Enter") {
      return true;
    }
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      appearancePicker.showIconGrid();
    }
    return true;
  }
}
