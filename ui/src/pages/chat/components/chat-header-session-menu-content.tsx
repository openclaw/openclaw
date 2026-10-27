import type { JSX } from "@solidjs/web";
import { createMemo, merge, onSettled, Show } from "solid-js";
import { serializeSidebarEntry } from "../../../app-navigation.ts";
import { isNativeLocalGateway } from "../../../app/native-editor-locality.runtime.ts";
import { resolveSidebarSessionParentKey } from "../../../components/app-sidebar-session-parent.ts";
import { BoardGrantedCapabilities } from "../../../components/board/board-widget-capabilities.solid.tsx";
import { boardWidgetMenuEntries } from "../../../components/board/board-widget-menu.tsx";
import { activateMenuShortcut } from "../../../components/menu-shortcut-activation.ts";
import { sessionMenuReasons } from "../../../components/session-menu-access.ts";
import {
  SessionMenuActions,
  type SessionMenuData,
} from "../../../components/session-menu-actions.ts";
import { compactSessionMenuViewForValue } from "../../../components/session-menu-compact.ts";
import { sessionMenuDataFromRow } from "../../../components/session-menu-data.ts";
import { useSessionMenuEntries } from "../../../components/session-menu-view.tsx";
import { createSessionOwnerMenu } from "../../../components/session-owner-menu.ts";
import { sessionPlacementAction } from "../../../components/session-placement-action.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { MenuControls, MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { readSessionMethodAccess } from "../../../lib/session-method-access.ts";
import { collectKnownSessionGroups } from "../../../lib/sessions/grouping.ts";
import {
  canDeleteSessionRows,
  isNativeCatalogAdoptionSessionKey,
  isPinnableUiSessionRow,
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
} from "../../../lib/sessions/session-key.ts";
import {
  canCopySessionMarkdown,
  canSplitSessionView,
} from "../../../lib/sessions/session-menu-navigation.ts";
import { isChatBubbleMode, setChatBubbleMode } from "../chat-bubble-mode.ts";
import { ChatPaneHeaderMemo } from "../chat-pane-header-memo.ts";
import { ChatPaneNativeSessionActions } from "../chat-pane-native-session-actions.ts";
import { runChatHeaderSessionAction } from "../chat-pane-session-menu-actions.ts";
import type { HeaderMenuAction, HeaderMenuActionKind } from "../chat-pane-session-menu-contract.ts";
import { buildContinueInTerminalCommand } from "../continue-in-terminal-command.ts";
import { createMobileHeaderSessionMenu } from "./chat-header-session-menu-mobile.tsx";
import type {
  HeaderMenuContentProps,
  HeaderMenuProps,
  CompactMenuView,
} from "./chat-header-session-menu.tsx";
import { useChatQuickActionEntries } from "./chat-quick-action.tsx";
import { useChatSessionSharingMenu } from "./chat-session-sharing-menu.tsx";
import { canManageChatSessionSharing } from "./chat-session-sharing-shared.tsx";

const COMPACT_MENU_VIEW_BY_VALUE: Record<string, CompactMenuView> = {
  "compact:open-sharing": "sharing",
  "compact:open-view": "view",
};

const VIEW_SETTINGS = [
  ["reasoning", "chatShowThinking", "chat.view.reasoning", false],
  ["tool-calls", "chatShowToolCalls", "chat.view.toolCalls", true],
  ["commentary", "chatPersistCommentary", "chat.view.commentary", undefined],
] as const;

export function ChatHeaderSessionMenuContent(inputs: HeaderMenuContentProps) {
  const sessionDataMemo = new ChatPaneHeaderMemo<SessionMenuData>();
  const reasonsMemo = new ChatPaneHeaderMemo<Partial<Record<HeaderMenuActionKind, string>>>();
  const groupsMemo = new ChatPaneHeaderMemo<string[]>();
  const panePresentation = createMemo((): Partial<HeaderMenuProps> => {
    const menu = inputs.menuProps;
    const source = menu.actionSource;
    const row = source?.readRow();
    if (!source || !row) {
      return {};
    }
    const owner = source.readOwner();
    const snapshot = owner.context.gateway.snapshot;
    const agentsList = owner.context.agents.state.agentsList;
    const mainKey = resolveUiConfiguredMainKey({ agentsList, hello: snapshot.hello });
    const mainSessionKey = resolveUiConversationIdentity(
      { agentsList, hello: snapshot.hello },
      "main",
      parseAgentSessionKey(row.key)?.agentId ?? row.agentId,
    ).sessionKey;
    const label = menu.session.label;
    const isChild =
      !isSubagentSessionKey(row.key) &&
      Boolean(resolveSidebarSessionParentKey(row, new Set([mainSessionKey])));
    const archiving = owner.context.sessions.archiveVisibility(row.key) === "pending";
    const pinned = owner.context.navigation.snapshot.sidebarEntries.includes(
      serializeSidebarEntry({ type: "session", key: row.key }),
    );
    const pinnable = isPinnableUiSessionRow(row);
    const session = sessionDataMemo.read(
      [
        label,
        sessionPlacementAction(row),
        row.key,
        row.agentId,
        row.sessionId,
        isChild,
        pinned,
        pinnable,
        row.snoozedUntil,
        row.unread,
        row.hiddenFromInvolvingMe,
        row.communication,
        row.effectiveCommunication,
        row.archived,
        archiving,
        row.category,
        row.icon,
        row.color,
      ],
      () => sessionMenuDataFromRow(row, { label, isChild, pinned, pinnable, archiving }),
    );
    const sessionReasons = sessionMenuReasons({
      snapshot,
      placementRow: row,
      requiredProfile: agentsList?.sessionPlacement?.requiredProfile?.id,
      session: { ...row, pinnable },
    });
    const assignment = readSessionMethodAccess(snapshot, {
      method: "sessions.assignOwner",
      params: { key: row.key, owner: { type: "human", id: snapshot.selfUser?.id ?? "profile" } },
      requiredScope: "operator.write",
    });
    const terminal =
      snapshot.client && snapshot.phase === "connected"
        ? buildContinueInTerminalCommand({
            gatewayUrl: snapshot.client.gatewayUrl,
            sessionKey: row.key,
            rowAgentId: row.agentId,
            selectedAgentId: owner.context.agentSelection.state.selectedId ?? undefined,
          })
        : undefined;
    const terminalReason = !terminal
      ? t("chat.sessionHeader.continueInTerminal.disconnected")
      : terminal.ok
        ? undefined
        : t(
            terminal.reason === "query-routed"
              ? "chat.sessionHeader.continueInTerminal.queryRouted"
              : "chat.sessionHeader.continueInTerminal.unavailable",
          );
    const reasons = {
      ...sessionReasons,
      ...(!assignment.allowed ? { "assign-owner": assignment.reason } : {}),
      ...(terminalReason ? { "continue-in-terminal": terminalReason } : {}),
    };
    const groups = owner.context.sessions.state.groups;
    const sessions = owner.context.sessions.state.result?.sessions;
    return {
      session,
      worktreePath: row.execNode || !isNativeLocalGateway() ? null : source.workspaceRoot,
      copyMarkdownAllowed: canCopySessionMarkdown(snapshot),
      splitAllowed: canSplitSessionView(),
      mainKey,
      groups: groupsMemo.read([groups, sessions], () =>
        collectKnownSessionGroups(groups ?? [], sessions ?? []),
      ),
      actionDisabledReasons: reasonsMemo.read(Object.entries(reasons).flat(), () => reasons),
      archiveAllowed: owner.canArchiveHeaderSession(row),
      deleteAllowed:
        !isNativeCatalogAdoptionSessionKey(row.key) && canDeleteSessionRows([row], mainKey),
    };
  });
  const props = merge(() => inputs.menuProps, panePresentation);
  const controls: MenuControls = {
    get elements() {
      return inputs.controls.elements;
    },
    ref: () => inputs.controls.ref(),
  };
  const presented = () => inputs.presented;
  const onAction = (action: HeaderMenuAction) => {
    if (props.onAction && props.onAction(action) !== false) {
      return;
    }
    const source = props.actionSource;
    if (source) {
      const row = source.readRow();
      if (row) {
        void runChatHeaderSessionAction(source.readOwner(), action, row);
      }
    }
  };
  const nativeActions = new ChatPaneNativeSessionActions();
  const sessionActions = createMemo(() => {
    const source = props.actionSource;
    const actions = source
      ? [
          ...nativeActions.read(
            source.readOwner().context,
            source.readRow(),
            source.stopDisabledReason,
            onAction,
          ),
          ...props.sessionActions,
        ]
      : props.sessionActions;
    return props.composeSessionActions?.(actions) ?? actions;
  });
  const quickActions = useChatQuickActionEntries(sessionActions, false, "quick:");
  const viewActions = useChatQuickActionEntries(() => props.viewActions ?? [], true, "layout:");
  const mobile = () => props.mobile === true && Boolean(props.mobileHost) && !props.boardWidgetMenu;
  const state = merge(props, () => ({
    compact: mobile() || props.compact,
    selectionCount: 1,
    navigationAllowed: true,
    disabled: false,
  }));
  const readState = () => state;
  const close = () => {
    inputs.readMenu()?.close();
  };
  const actions = new SessionMenuActions(
    () => {
      void inputs.host.updateComplete.then(() => {
        if (inputs.compactView === "icon") {
          view.appearance.focusFirst();
        } else {
          inputs.readMenu()?.focusFirst();
        }
      });
    },
    readState,
    onAction,
    close,
    createSessionOwnerMenu(presented),
  );
  const view = useSessionMenuEntries(actions, readState, {
    controls,
    openInExtra: () => [
      {
        id: "continue-in-terminal",
        label: t("chat.sessionHeader.continueInTerminal.action"),
        class: "session-menu__item",
        labelClass: "session-menu__text",
        disabled: Boolean(props.actionDisabledReasons["continue-in-terminal"]),
        attributes: { title: props.actionDisabledReasons["continue-in-terminal"] },
        icon: (
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name="terminal" />
          </span>
        ),
      },
    ],
  });
  const sharing = useChatSessionSharingMenu(
    merge(
      {
        session: undefined,
        state: undefined,
        onOpen: () => {},
        onVisibilityChange: () => {},
        onMemberChange: () => {},
      },
      () => props.sharing ?? {},
    ),
    controls,
  );
  const shortcut = (event: KeyboardEvent) => {
    if (props.paneTitle !== undefined || !actions.handleKeydown(event, view.appearance)) {
      activateMenuShortcut(inputs.readMenu()?.overlay.surface, event);
    }
  };
  onSettled(() => {
    const handle = inputs.readMenu();
    const stopShortcut = handle
      ? listen(handle.overlay.surface, "keydown", shortcut, true)
      : undefined;
    inputs.onReady({
      items,
      select,
      escape: (event) =>
        props.paneTitle === undefined && actions.handleKeydown(event, view.appearance),
      openChange: (isOpen) => {
        if (isOpen && props.paneTitle === undefined) {
          actions.loadOwners();
        } else if (!isOpen && !mobile()) {
          actions.advanced.close();
        }
      },
    });
    return () => {
      inputs.onReady(undefined);
      stopShortcut?.();
    };
  });
  const content = (id: string, value: JSX.Element): MenuEntry => ({
    kind: "content",
    id,
    content: value,
  });
  const separator = (id: string) =>
    content(id, <div class="session-menu__separator" role="separator" />);
  // Replacing a divider can move adjacent branches and close their native popovers.
  const paletteDivider = separator("palette-divider");
  const boardDivider = separator("board-divider");
  const viewDivider = separator("view-divider");
  const primaryDivider = separator("primary-divider");
  const organizationDivider = separator("organization-divider");
  const palette = (): MenuItem => ({
    id: "open-command-palette",
    label: t("chat.openCommandPalette"),
    class: "session-menu__item",
    labelClass: "session-menu__text",
    icon: (
      <span class="session-menu__icon" aria-hidden="true">
        <Icon name="search" />
      </span>
    ),
  });
  const mobileMenu = createMobileHeaderSessionMenu({
    view,
    currentOwner: () => props.currentOwner,
    category: () => props.session.category,
    viewOptions,
    host: () => props.mobileHost,
    source: () => inputs.readMenu()?.overlay.trigger,
    closeMenu: close,
    select: (item) => select(item, new CustomEvent("select", { cancelable: true, detail: item })),
  });
  const browserOnlyInfo = content(
    "browser-only",
    <div class="session-menu__info" role="note">
      {t("quickSettings.personal.browserOnly")}
    </div>,
  );
  function viewOptions(): MenuEntry[] {
    if (props.paneTitle !== undefined) {
      return [...viewActions()];
    }
    return [
      ...VIEW_SETTINGS.map(([value, key, label, onboarding]) => ({
        id: `view:${value}`,
        label: t(label),
        class: "session-menu__item",
        labelClass: "session-menu__text",
        type: "checkbox" as const,
        checked:
          props.onboarding && onboarding !== undefined ? onboarding : props.settings[key] !== false,
        disabled: props.onboarding,
        attributes: { title: props.onboarding ? t("chat.onboardingDisabled") : undefined },
        closeOnSelect: false,
      })),
      ...(props.bubbleModeEnabled
        ? [
            {
              id: "view:speech-bubbles",
              label: t("chat.view.speechBubbles"),
              class: "session-menu__item",
              labelClass: "session-menu__text",
              type: "checkbox" as const,
              checked: isChatBubbleMode(
                props.settings,
                props.session.target?.key ?? "",
                true,
                props.mainKey,
              ),
              disabled: props.onboarding,
              attributes: { title: props.onboarding ? t("chat.onboardingDisabled") : undefined },
              closeOnSelect: false,
            },
          ]
        : []),
      ...viewActions(),
      ...(props.viewContent ? [content("native-header-actions", props.viewContent)] : []),
      ...(props.preferencesBrowserOnly ? [browserOnlyInfo] : []),
    ];
  }
  function group(
    viewName: "view" | "sharing",
    label: string,
    icon: IconName,
    disabled = false,
  ): MenuItem {
    return {
      id: props.compact ? `compact:open-${viewName}` : `submenu:${viewName}`,
      label,
      labelClass: "session-menu__text",
      class: "session-menu__item",
      disabled,
      icon: (
        <span class="session-menu__icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
      ),
      details: props.compact ? (
        <span class="session-menu__icon session-menu__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      ) : undefined,
      children: props.compact
        ? undefined
        : viewName === "sharing"
          ? sharing.items()
          : viewOptions(),
      closeOnSelect: false,
    };
  }
  function root(): MenuEntry[] {
    if (props.paneTitle !== undefined) {
      return [
        ...quickActions(),
        ...(viewActions().length ? [group("view", t("chat.view.menu"), "eye")] : []),
      ];
    }
    const board = props.boardWidgetMenu;
    return [
      ...(props.mobile === false ? [] : [palette()]),
      ...((props.mobile !== false || board) && props.onOpenDetails
        ? [
            {
              id: "session-details",
              label: t("chat.sessionDetails.menu"),
              class: "session-menu__item",
              labelClass: "session-menu__text",
              icon: (
                <span class="session-menu__icon" aria-hidden="true">
                  <Icon name="listChecks" />
                </span>
              ),
            },
          ]
        : []),
      ...(props.mobile === false ? [] : [paletteDivider]),
      ...(board
        ? [
            content(
              "board-heading",
              <>
                <div class="board-widget__page-menu-heading">
                  <strong>{board.widget.title || board.widget.name}</strong>
                </div>
                <BoardGrantedCapabilities widget={board.widget} presentation="details" />
              </>,
            ),
            ...(board.canMutate
              ? boardWidgetMenuEntries({
                  widget: board.widget,
                  tabs: board.tabs,
                  disabled: false,
                }).map((entry) => Object.assign(entry, { id: `board-widget:${entry.id}` }))
              : []),
            boardDivider,
          ]
        : []),
      ...(props.compact &&
      props.sharing?.session &&
      canManageChatSessionSharing(props.sharing.session)
        ? [
            group(
              "sharing",
              t("chat.sessionSharing.menu"),
              "users",
              Boolean(props.sharing.openDisabledReason),
            ),
          ]
        : []),
      ...quickActions().filter((entry) => entry.id === "quick:open-split-view"),
      group("view", t("chat.view.menu"), "eye"),
      viewDivider,
      ...view.primary(),
      primaryDivider,
      ...view.organization(),
      ...quickActions().filter((entry) => entry.id !== "quick:open-split-view"),
      organizationDivider,
      ...view.advanced(),
    ];
  }
  const backDivider = separator("back-divider");
  const items = createMemo(
    (): MenuEntry[] => {
      const current = inputs.compactView;
      if (mobile()) {
        return current === "snooze" ? view.compact(current) : mobileMenu.root(root());
      }
      if (!props.compact || current === "root") {
        return root();
      }
      if (current !== "sharing" && current !== "view") {
        return view.compact(current);
      }
      return [
        {
          id: "compact:back",
          label: t("common.back"),
          class: "session-menu__item session-menu__back",
          icon: (
            <span class="session-menu__icon" aria-hidden="true">
              <Icon name="arrowLeft" />
            </span>
          ),
          closeOnSelect: false,
        },
        backDivider,
        ...(current === "sharing" && props.sharing ? sharing.items() : viewOptions()),
      ];
    },
    { lazy: true },
  );
  function select(item: MenuItem, event: CustomEvent<MenuItem>) {
    const value = item.id;
    if (mobile() && mobileMenu.open(value)) {
      event.preventDefault();
      return;
    }
    if (value.startsWith("board-widget:")) {
      props.boardWidgetMenu?.onSelect(value.slice("board-widget:".length));
      return;
    }
    const managementView = compactSessionMenuViewForValue(value);
    const nextView = managementView ?? COMPACT_MENU_VIEW_BY_VALUE[value];
    if (nextView) {
      event.preventDefault();
      inputs.onCompactViewChange(nextView);
      if (managementView === "icon") {
        view.appearance.prepare();
      } else if (nextView === "sharing" && !props.sharing?.openDisabledReason) {
        props.sharing?.onOpen();
      }
      onSettled(() => actions.focusCurrentView());
      return;
    }
    if (value === "session-details") {
      event.preventDefault();
      close();
      const trigger = inputs.readMenu()?.overlay.trigger;
      if (trigger) {
        props.onOpenDetails?.(trigger);
      }
      return;
    }
    if (value === "open-command-palette") {
      close();
      props.onOpenCommandPalette();
      return;
    }
    if (value.startsWith("layout:")) {
      const action = props.viewActions?.find(
        (candidate) => candidate.id === value.slice("layout:".length),
      );
      if (action && action.kind !== "status" && !action.disabled) {
        // Restore the pane trigger before an action can remove its menu and pane.
        event.preventDefault();
        close();
        void action.onActivate();
      }
      return;
    }
    if (value.startsWith("quick:")) {
      const action = sessionActions().find(
        (candidate) => candidate.id === value.slice("quick:".length),
      );
      if (action && !action.disabled) {
        close();
        void action.onActivate();
      }
      return;
    }
    if (value.startsWith("view:")) {
      event.preventDefault();
      if (props.onboarding) {
        return;
      }
      const setting = value.slice("view:".length);
      const option = VIEW_SETTINGS.find(([id]) => id === setting);
      if (option) {
        props.onSettingsChange({ [option[1]]: props.settings[option[1]] === false });
      } else if (
        setting === "speech-bubbles" &&
        props.bubbleModeEnabled &&
        props.session.target?.key
      ) {
        props.onSettingsChange(
          setChatBubbleMode(
            props.settings,
            props.session.target.key,
            !isChatBubbleMode(
              props.settings,
              props.session.target.key,
              props.bubbleModeEnabled,
              props.mainKey,
            ),
          ),
        );
      }
      return;
    }
    if (
      value.startsWith("visibility:") ||
      value.startsWith("permission:") ||
      value.startsWith("public:")
    ) {
      if (props.sharing) {
        void sharing.select(value);
      }
      return;
    }
    if (actions.handleSelect(value)) {
      event.preventDefault();
      return;
    }
    if (value === "continue-in-terminal" && !props.actionDisabledReasons[value]) {
      close();
      onAction({ kind: value });
    }
  }
  return (
    <>
      <Show when={!presented()}>
        {(_parked) => {
          onSettled(() => actions.advanced.close());
          return undefined;
        }}
      </Show>
      {inputs.renderItems(items)}
    </>
  );
}
