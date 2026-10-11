import { ContextConsumer } from "@lit/context";
import { html, nothing, type ReactiveControllerHost, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../api/types.ts";
import { applicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { EDITOR_IDS, type EditorId } from "../lib/editor-links.ts";
import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import { menuShortcutHint } from "./menu-shortcuts.ts";
import type { SessionCommunicationMenuAction } from "./session-communication-options.ts";
import { SessionMenuAppearance } from "./session-icon-picker.ts";
import {
  renderCompactSessionMenuFrame,
  renderCompactSessionMenuNavigationItem,
  type CompactSessionMenuView,
} from "./session-menu-compact.ts";
import {
  renderSessionCopyOptions,
  renderSessionOpenOptions,
  renderSessionGroupOptions,
  sessionArchiveShortcut,
} from "./session-menu-options.ts";
import { SessionMenuSettings } from "./session-menu-settings.ts";
import { SessionMenuSnooze, type SessionSnoozeMenuAction } from "./session-menu-snooze.ts";
import type { SessionCreatedActor, SessionOwnerOption } from "./session-owner-chip.ts";
import { SessionOwnerMenu } from "./session-owner-menu.ts";
import "../styles/sidebar-menus.css";

registerSessionOrganizationEnglish();

export type SessionMenuData = {
  label: string;
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
  | SessionSnoozeMenuAction;

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

type SessionMenuActionsHost = ReactiveControllerHost &
  HTMLElement & { updateComplete: Promise<unknown> };

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
  renderOpenInExtra?: (inline: boolean) => TemplateResult;
};

/** Canonical single-session actions shared by sidebar and chat-header menus. */
export class SessionMenuActions {
  private readonly context;
  readonly ownerMenu: SessionOwnerMenu;
  private readonly appearance;
  readonly advanced;
  private readonly snoozeMenu = new SessionMenuSnooze({
    readWakeTime: () => this.readState().session.snoozedUntil,
    eligible: () => !this.actionExtraDisabled("snooze"),
    disabled: (kind) => this.actionDisabled(kind, this.actionExtraDisabled(kind)),
    disabledReason: (kind) => this.readState().actionDisabledReasons[kind],
    renderItem: (...args) => this.renderItem(...args),
    renderSubmenu: (...args) => this.renderSubmenu(...args),
    runAction: (action) => this.runAction(action),
  });

  constructor(
    private readonly host: SessionMenuActionsHost,
    private readonly readState: () => SessionMenuActionsState,
    private readonly onAction: (action: SessionManagementAction) => void,
    private readonly onClose: () => void,
  ) {
    this.context = new ContextConsumer(host, { context: applicationContext, subscribe: true });
    new SubscriptionsController(host).watchStore(() => this.context.value?.gateway);
    this.ownerMenu = new SessionOwnerMenu(host);
    this.appearance = new SessionMenuAppearance(
      host,
      readState,
      (kind) => this.actionDisabled(kind),
      (action) => this.runAction(action),
    );
    this.advanced = new SessionMenuSettings(host, {
      context: () => this.context.value,
      readState: () => this.readState(),
      disabled: (kind) => this.actionDisabled(kind),
      renderSubmenu: (...args) => this.renderSubmenu(...args),
      renderItem: (...args) => this.renderItem(...args),
      renderInvolvement: (inline) => this.renderInvolvementAction(inline),
      renderDelete: (inline) => this.renderDeleteAction(inline),
      runAction: (action) => this.runAction(action),
    });
  }

  get involvementAvailable(): boolean {
    return (
      this.context.value?.gateway.snapshot.hello?.policy?.hasMultipleSessionSharingIdentities ===
      true
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
    if (this.snoozeMenu.handleSelect(value)) {
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

  prepareCompactView(view: CompactSessionMenuView): void {
    if (view === "icon") {
      this.appearance.prepare();
    }
  }

  focusCurrentView(): void {
    void this.host.updateComplete.then(() => {
      const first =
        this.host.querySelector<HTMLElement>(".session-menu__appearance button:not(:disabled)") ??
        this.host.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])");
      first?.focus();
    });
  }

  handleKeydown(
    event: KeyboardEvent,
    appearancePicker: Pick<SessionMenuAppearance, "showIconGrid"> = this.appearance,
  ): boolean {
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

  private renderItem(
    kind: SessionManagementActionKind,
    label: string,
    icon: TemplateResult,
    options: { shortcut?: string; inline?: boolean; title?: string } = {},
  ) {
    const state = this.readState();
    const archiveShortcut = kind === "toggle-archived" ? sessionArchiveShortcut(state) : undefined;
    return html`<wa-dropdown-item
      slot=${options.inline === false ? "submenu" : nothing}
      class=${`session-menu__item${kind === "delete" ? " session-menu__item--destructive" : ""}`}
      variant=${kind === "delete" ? "danger" : "neutral"}
      value=${kind}
      data-shortcut=${options.shortcut ?? nothing}
      aria-keyshortcuts=${options.shortcut?.toUpperCase() ?? nothing}
      ?data-new-tab-action=${kind === "open-new-tab" || kind === "open-new-window"}
      ?disabled=${this.actionDisabled(kind, this.actionExtraDisabled(kind))}
      title=${state.actionDisabledReasons[kind] ?? options.title ?? nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
      <span class="session-menu__text">${label}</span>
      ${options.shortcut ? menuShortcutHint(options.shortcut, archiveShortcut) : nothing}
    </wa-dropdown-item>`;
  }

  private renderSubmenu(
    view: Exclude<CompactSessionMenuView, "root">,
    label: string,
    icon: TemplateResult,
    disabled = false,
    title?: string,
    inline = true,
  ): TemplateResult {
    if (this.readState().compact) {
      return renderCompactSessionMenuNavigationItem({
        value: `compact:open-${view}`,
        shortcut: view === "archive" ? "a" : undefined,
        details:
          view === "archive"
            ? menuShortcutHint("a", sessionArchiveShortcut(this.readState()))
            : undefined,
        label,
        icon,
        disabled,
        title,
      });
    }
    const shortcut = view === "icon" ? "i" : view === "archive" ? "a" : undefined;
    return html`<wa-dropdown-item
      slot=${inline ? nothing : "submenu"}
      class=${`session-menu__item${view === "assign-owner" ? " people-menu__submenu" : view === "advanced" ? " session-menu__advanced" : ""}`}
      ?disabled=${disabled}
      title=${title ?? nothing}
      data-shortcut=${shortcut ?? nothing}
      aria-keyshortcuts=${shortcut?.toUpperCase() ?? nothing}
      @submenu-opening=${view === "icon" ? this.appearance.focusOnOpen : nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
      <span class="session-menu__text">${label}</span>
      ${shortcut ? menuShortcutHint(shortcut) : nothing} ${this.renderSubmenuBody(view)}
    </wa-dropdown-item>`;
  }

  renderPrimaryActions() {
    const { session, selectionCount } = this.readState();
    const batch = selectionCount > 1;
    const count = String(selectionCount);
    return html`
      ${
        batch || session.pinnable === false || session.isChild
          ? nothing
          : this.renderItem(
              "toggle-pin",
              t(session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession"),
              session.pinned ? icons.pinOff : icons.pin,
              { shortcut: "p" },
            )
      }
      ${
        batch
          ? nothing
          : this.renderItem("rename", t("sessionsView.renameSessionMenu"), icons.edit, {
              shortcut: "r",
            })
      }
      ${this.renderItem(
        "toggle-unread",
        t(
          batch
            ? session.unread
              ? "sessionsView.markReadCount"
              : "sessionsView.markUnreadCount"
            : session.unread
              ? "sessionsView.markRead"
              : "sessionsView.markUnread",
          { count },
        ),
        session.unread ? icons.eye : icons.circle,
        { shortcut: "u" },
      )}
      ${
        !batch && this.readState().navigationAllowed
          ? this.renderItem("copy-session-link", t("sessionsView.copyLink"), icons.link, {
              shortcut: "c",
            })
          : nothing
      }
      ${batch ? this.renderArchiveAction() : nothing}
    `;
  }

  private renderInvolvementAction(inline = true) {
    const { session, selectionCount } = this.readState();
    return this.involvementAvailable &&
      selectionCount === 1 &&
      session.hiddenFromInvolvingMe !== undefined
      ? this.renderItem(
          "toggle-involving-me",
          t(
            session.hiddenFromInvolvingMe
              ? "sessionsView.showInInvolvingMe"
              : "sessionsView.hideFromInvolvingMe",
          ),
          session.hiddenFromInvolvingMe ? icons.eye : icons.eyeOff,
          { inline },
        )
      : nothing;
  }

  renderOrganizationActions() {
    const state = this.readState();
    const batch = state.selectionCount > 1;
    return html`
      ${
        !batch
          ? this.ownerMenu.multipleOwners
            ? this.renderSubmenu(
                "assign-owner",
                t("sessionsView.assignTo"),
                icons.users,
                this.actionDisabled("assign-owner"),
                state.actionDisabledReasons["assign-owner"],
              )
            : this.ownerMenu.renderStatus(true)
          : nothing
      }
      ${this.renderGroupAction()}
      ${!batch && state.session.isChild ? this.renderItem("move-to-top-level", t("sessionsView.moveToTopLevel"), icons.arrowUpRight) : nothing}
      ${state.involvingMeContext ? this.renderInvolvementAction() : nothing}
      ${!batch ? html`${this.snoozeMenu.renderAction()} ${this.renderArchiveAction()}` : nothing}
    `;
  }

  renderAdvancedAction() {
    return this.advanced.renderAction();
  }

  private renderArchiveAction(inline = true, choice = false): TemplateResult {
    const state = this.readState();
    const { session, selectionCount } = state;
    if (!choice && selectionCount === 1 && session.hasChildren && !session.archived) {
      return this.renderSubmenu(
        "archive",
        t(session.archiving ? "sessionsView.archiving" : "sessionsView.archiveSession"),
        icons.archive,
        this.actionDisabled("toggle-archived", this.actionExtraDisabled("toggle-archived")),
        state.actionDisabledReasons["toggle-archived"],
      );
    }
    return this.renderItem(
      "toggle-archived",
      t(
        session.archiving
          ? "sessionsView.archiving"
          : selectionCount > 1
            ? session.archived
              ? "sessionsView.restoreSessionCount"
              : "sessionsView.archiveSessionCount"
            : session.archived
              ? "sessionsView.restoreSession"
              : !choice
                ? "sessionsView.archiveSession"
                : "sessionsView.archiveSessionOnly",
        { count: String(selectionCount) },
      ),
      session.archived ? icons.archiveRestore : icons.archive,
      { inline, shortcut: "a" },
    );
  }

  private renderGroupAction() {
    const state = this.readState();
    const batch = state.selectionCount > 1;
    const count = String(state.selectionCount);
    const label = batch
      ? t("sessionsView.moveToGroupMenuCount", { count })
      : t("sessionsView.moveToGroupMenu");
    return this.renderSubmenu(
      "group",
      label,
      icons.folder,
      this.actionDisabled("move-to-group"),
      state.actionDisabledReasons["move-to-group"],
    );
  }

  renderDeleteAction(inline = true) {
    const state = this.readState();
    const label =
      state.selectionCount > 1
        ? t("sessionsView.deleteSessionCount", { count: String(state.selectionCount) })
        : t("sessionsView.deleteSessionMenu");
    return this.renderItem("delete", label, icons.trash, { shortcut: "d", inline });
  }

  renderCompactView(view: CompactSessionMenuView) {
    return view === "root"
      ? nothing
      : renderCompactSessionMenuFrame(
          this.renderSubmenuBody(view, true),
          view === "icon" || view === "copy" || view === "open-in" ? "advanced" : "root",
        );
  }

  private renderSubmenuBody(
    view: Exclude<CompactSessionMenuView, "root">,
    inline = false,
  ): TemplateResult {
    const state = this.readState();
    switch (view) {
      case "advanced":
        return this.advanced.render(inline);
      case "archive":
        return html`${this.renderArchiveAction(inline, true)}
        ${this.renderItem("archive-tree", t("sessionsView.archiveSessionTree"), icons.archive, { inline })}`;
      case "snooze":
        return this.snoozeMenu.renderSubmenu(inline);
      case "copy":
        return renderSessionCopyOptions({
          inline,
          navigationAllowed: state.navigationAllowed,
          renderItem: (...args) => this.renderItem(...args),
        });
      case "open-in":
        return renderSessionOpenOptions({
          inline,
          navigationAllowed: state.navigationAllowed,
          splitAllowed: state.splitAllowed,
          renderOpenInExtra: state.renderOpenInExtra,
          worktreePath: state.worktreePath,
          editorDisabled: this.actionDisabled("open-in"),
          renderItem: (...args) => this.renderItem(...args),
        });
      case "icon":
        return this.appearance.render(inline);
      case "group":
        return this.renderGroupSubmenu(inline);
      case "assign-owner":
        return this.ownerMenu.render(
          {
            currentOwner: state.currentOwner,
            disabled: this.actionDisabled("assign-owner"),
            disabledReason: state.actionDisabledReasons["assign-owner"],
          },
          inline,
        );
      default:
        return view satisfies never;
    }
  }

  private renderGroupSubmenu(inline = false) {
    const state = this.readState();
    return renderSessionGroupOptions({
      inline,
      category: state.session.category,
      categoryClearReturnsToGroups: state.session.categoryClearReturnsToGroups,
      groups: state.groups,
      actionDisabled: (kind) => this.actionDisabled(kind),
      actionTitle: (kind) => state.actionDisabledReasons[kind] ?? nothing,
    });
  }
}
