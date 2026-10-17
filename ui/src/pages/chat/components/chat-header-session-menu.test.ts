/* @vitest-environment jsdom */

import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import type { UiSettings } from "../../../app/settings.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import { createSessionOwnerMenuHarness } from "../../../test-helpers/session-owner-menu.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import type { HeaderMenuAction } from "./chat-header-session-menu.ts";
import { PaneHeaderView } from "./chat-pane-header.tsx";
import "./chat-header-session-menu.ts";
import type { ChatSessionSharingProps } from "./chat-session-sharing.solid.tsx";
import { openNativeSessionMenu } from "./native-session-menu.runtime.ts";

type HeaderMenuElement = HTMLElementTagNameMap["openclaw-chat-header-session-menu"];
type MenuItemElement = HTMLButtonElement;

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
});

function settings(): UiSettings {
  return {
    gatewayUrl: "ws://localhost:18789",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: true,
    navCollapsed: false,
    navWidth: 280,
    sidebarEntries: [],
  };
}

async function mountMenu(
  {
    context,
    session,
    ...properties
  }: Partial<
    Pick<
      HeaderMenuElement,
      | "worktreePath"
      | "onboarding"
      | "preferencesBrowserOnly"
      | "compact"
      | "bubbleModeEnabled"
      | "copyMarkdownAllowed"
      | "splitAllowed"
      | "sessionActions"
      | "sharing"
      | "currentOwner"
      | "actionDisabledReasons"
      | "forkFromLastCompleted"
      | "archiveAllowed"
      | "archiveShortcut"
      | "deleteAllowed"
      | "onOpenCommandPalette"
      | "onSettingsChange"
      | "onAction"
    >
  > & {
    session?: Partial<HeaderMenuElement["session"]>;
    context?: ApplicationContext;
  } = {},
  open = true,
): Promise<HeaderMenuElement> {
  const container = context
    ? createApplicationContextProvider(context)
    : document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const menu = document.createElement("openclaw-chat-header-session-menu");
  Object.assign(menu, {
    copyMarkdownAllowed: true,
    archiveAllowed: true,
    deleteAllowed: true,
    settings: settings(),
    groups: ["Projects"],
    ...properties,
    session: { ...menu.session, label: "Test session", sessionId: "session-123", ...session },
  } satisfies Partial<HeaderMenuElement>);
  container.append(menu);
  await menu.updateComplete;
  if (open) {
    expect(menu.openMenu()).toBe(true);
    flush();
    await materializeSubmenus(menu);
    await menu.updateComplete;
  }
  return menu;
}

function panel(menu: ParentNode): HTMLElement {
  const found = menu.querySelector<HTMLElement>(".chat-header-session-menu__panel");
  if (!found) {
    throw new Error("Expected header menu panel");
  }
  return found;
}

function itemLabel(menuItem: Element): string {
  return (
    menuItem.querySelector(".session-menu__text")?.textContent?.trim() ??
    menuItem.getAttribute("aria-label") ??
    ""
  );
}

function rootLabels(menu: ParentNode): string[] {
  const root = panel(menu);
  return [...root.querySelectorAll('[role^="menuitem"]')]
    .filter((candidate) => candidate.closest('[role="menu"]') === root)
    .map(itemLabel);
}

function item(menu: ParentNode, label: string): MenuItemElement {
  const found = [...menu.querySelectorAll<MenuItemElement>('[role^="menuitem"]')].find(
    (candidate) => itemLabel(candidate) === label,
  );
  if (!found) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return found;
}

async function materializeSubmenus(menu: HeaderMenuElement): Promise<void> {
  const visit = async (root: HTMLElement) => {
    for (const trigger of root.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    )) {
      if (trigger.closest('[role="menu"]') !== root || trigger.disabled) {
        continue;
      }
      trigger.click();
      flush();
      await menu.updateComplete;
      const branch = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
      if (!branch) {
        throw new Error("Expected submenu panel");
      }
      await visit(branch);
      if (branch.matches(":popover-open")) {
        trigger.click();
        flush();
      }
    }
  };
  await visit(panel(menu));
}

function submenuItems(trigger: HTMLElement): MenuItemElement[] {
  const id = trigger.getAttribute("aria-controls");
  const root = id ? document.getElementById(id) : null;
  if (!root) {
    throw new Error("Expected submenu panel");
  }
  return [...root.querySelectorAll<MenuItemElement>('[role^="menuitem"]')].filter(
    (candidate) => candidate.closest('[role="menu"]') === root,
  );
}

async function select(menu: HeaderMenuElement, value: string) {
  await menu.updateComplete;
  if (!panel(menu).matches(":popover-open")) {
    expect(menu.openMenu()).toBe(true);
    flush();
  }
  const target = menu.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
  if (!target) {
    throw new Error(`Expected menu value: ${value}`);
  }
  const parents: HTMLElement[] = [];
  for (
    let root = target.closest<HTMLElement>('[role="menu"]');
    root && root !== panel(menu);
    root = root.parentElement?.closest<HTMLElement>('[role="menu"]') ?? null
  ) {
    parents.unshift(root);
  }
  for (const root of parents) {
    if (!root.matches(":popover-open")) {
      const trigger = document.getElementById(root.id.replace(/:content$/u, ":trigger"));
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Expected submenu trigger");
      }
      trigger.click();
      flush();
    }
  }
  await menu.updateComplete;
  flush();
  target.click();
  flush();
  await menu.updateComplete;
}

describe("chat header session menu", () => {
  it("keeps current session actions and their DOM identity across reopening", async () => {
    const menu = await mountMenu({}, false);
    expect(menu.querySelector(".chat-header-session-menu__trigger")).not.toBeNull();
    expect(panel(menu).matches(":popover-open")).toBe(false);
    menu.session = { ...menu.session, label: "Latest session", pinned: true };
    await menu.updateComplete;
    expect(menu.openMenu()).toBe(true);
    flush();
    const pin = item(menu, "Unpin session");
    panel(menu).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel(menu).matches(":popover-open")).toBe(false);
    expect(menu.openMenu()).toBe(true);
    flush();
    expect(item(menu, "Unpin session")).toBe(pin);
  });

  it.each(["shown", "aborted", "retargeted"] as const)(
    "opens only a current native popup request: %s",
    async (outcome) => {
      const menu = await mountMenu({}, false);
      const abort = new AbortController();
      if (outcome === "aborted") {
        abort.abort();
      }
      const opened = await openNativeSessionMenu({
        pane: menu.parentElement!,
        signal: abort.signal,
        isCurrent: () => outcome !== "retargeted",
      });
      expect(opened).toBe(outcome === "shown");
      expect(panel(menu).matches(":popover-open")).toBe(outcome === "shown");
      abort.abort();
      expect(panel(menu).matches(":popover-open")).toBe(outcome === "shown");
    },
  );

  it("settles native opening before a later selection or cancellation", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({ onAction }, false);
    const abort = new AbortController();
    expect(
      await openNativeSessionMenu({
        pane: menu.parentElement!,
        signal: abort.signal,
        isCurrent: () => true,
      }),
    ).toBe(true);
    await select(menu, "rename");
    expect(onAction).toHaveBeenCalledWith({ kind: "rename" });
    expect(panel(menu).matches(":popover-open")).toBe(false);
    abort.abort();
    expect(panel(menu).matches(":popover-open")).toBe(false);
  });

  it.each(["MacIntel", "Win32"])(
    "shows the direct Archive hint only for the current unarchived chat on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const menu = await mountMenu({ archiveShortcut: true });
      expect(
        item(menu, "Archive session")
          .querySelector(".session-menu__shortcut")
          ?.textContent?.replace(/\s+/gu, "")
          .trim(),
      ).toBe(platform === "MacIntel" ? "A/⌘⇧A" : "A/Ctrl+Shift+A");
      const inactive = await mountMenu();
      expect(
        item(inactive, "Archive session")
          .querySelector(".session-menu__shortcut")
          ?.textContent?.trim(),
      ).toBe("A");
      const archived = await mountMenu({ archiveShortcut: true, session: { archived: true } });
      expect(
        archived
          .querySelector('[data-value="toggle-archived"] .session-menu__shortcut')
          ?.textContent?.trim(),
      ).toBe("A");
    },
  );

  it.each([false, true])(
    "gates personal visibility for hidden=%s on multiple identities",
    async (hidden) => {
      const owner = createSessionOwnerMenuHarness();
      const onAction = vi.fn();
      const menu = await mountMenu({
        context: owner.context,
        session: { hiddenFromInvolvingMe: hidden },
        onAction,
      });
      for (const multiple of [false, true, false]) {
        owner.publish({
          hello: {
            ...gatewayHelloForMethods(["sessions.setInvolvement"]),
            policy: { hasMultipleSessionSharingIdentities: multiple },
          },
        });
        await menu.updateComplete;
        expect(menu.querySelector('[data-value="toggle-involving-me"]') !== null).toBe(multiple);
      }
    },
  );

  it.each([
    { name: "plain browser", nativeGateway: null, offered: false },
    { name: "native local gateway", nativeGateway: "local", offered: true },
    {
      name: "SSH-tunneled remote native gateway",
      nativeGateway: "remote",
      gatewayUrl: "ws://127.0.0.1:18789",
      offered: false,
    },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      offered: false,
    },
  ] as const)(
    "offers session editors only for native-local workspaces: $name",
    async (testCase) => {
      setNativeGatewayTestState(testCase.nativeGateway);
      const client = createGatewayBrowserClientFixture({
        gatewayUrl: "gatewayUrl" in testCase ? testCase.gatewayUrl : "ws://localhost:18789",
      });
      const { pane, state } = createTestChatPane({
        client,
        sessions: createSessionCapabilityFixture(),
      });
      const session = {
        key: state.sessionKey,
        kind: "direct" as const,
        updatedAt: 0,
        spawnedWorkspaceDir: "/workspace",
        ...("execNode" in testCase
          ? { execNode: testCase.execNode, execCwd: "/remote/workspace" }
          : {}),
      };
      state.settings = {} as ChatPageHost["settings"];
      const container = document.createElement("div");
      document.body.append(container);
      containers.push(container);
      mountSolid(
        () =>
          createComponent(
            PaneHeaderView,
            pane.renderPaneHeader(
              createPaneHeaderWorkspaceFixture(state),
              session,
              false,
              undefined,
              false,
              null,
            ),
          ),
        { container },
      );
      const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
      await menu?.updateComplete;
      expect(menu?.openMenu()).toBe(true);
      flush();
      await menu?.updateComplete;
      if (!menu) {
        throw new Error("Expected chat header session menu");
      }
      await materializeSubmenus(menu);

      expect(menu?.textContent?.includes("Open in")).toBe(true);
      expect(menu?.textContent?.includes("Cursor")).toBe(testCase.offered);
    },
  );

  it("preserves row-discovered groups when the gateway catalog lags", async () => {
    const session = {
      key: "agent:main:current",
      kind: "direct" as const,
      updatedAt: 2,
    };
    const sessions = createSessionCapabilityFixture({
      state: {
        error: null,
        groups: ["Catalog"],
        result: {
          count: 2,
          path: "",
          ts: 2,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            session,
            {
              key: "agent:main:discovered",
              kind: "direct",
              updatedAt: 1,
              category: "Discovered",
            },
          ],
        },
      },
    });
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });
    state.settings = {} as ChatPageHost["settings"];
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    mountSolid(
      () =>
        createComponent(
          PaneHeaderView,
          pane.renderPaneHeader(
            createPaneHeaderWorkspaceFixture(state),
            session,
            false,
            undefined,
            false,
            null,
          ),
        ),
      { container },
    );
    const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
    if (!menu) {
      throw new Error("Expected chat header session menu");
    }
    await menu.updateComplete;
    expect(menu.openMenu()).toBe(true);
    flush();
    await menu.updateComplete;

    await materializeSubmenus(menu);
    const moveToGroup = item(menu, "Move to group");
    const groupLabels = submenuItems(moveToGroup).map(itemLabel);
    expect(groupLabels).toEqual(["Catalog", "Discovered", "New group"]);
  });

  it.each([false, true])("gates view preferences during onboarding=%s", async (onboarding) => {
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const menu = await mountMenu({
      onboarding,
      bubbleModeEnabled: true,
      preferencesBrowserOnly: !onboarding,
      session: { target: { key: "agent:main:test" } },
      onSettingsChange,
    });
    const view = item(menu, "View");
    const viewItems = submenuItems(view);

    expect(viewItems.map(itemLabel)).toEqual([
      "Reasoning",
      "Tool calls",
      "Keep commentary",
      "Speech bubbles",
    ]);
    expect(viewItems.map((entry) => entry.getAttribute("aria-checked") === "true")).toEqual([
      !onboarding,
      true,
      true,
      false,
    ]);
    if (onboarding) {
      expect(viewItems.every((entry) => entry.disabled)).toBe(true);
      expect(
        viewItems.every((entry) => entry.getAttribute("title") === "Disabled during setup"),
      ).toBe(true);
    } else {
      expect(
        document
          .getElementById(view.getAttribute("aria-controls")!)
          ?.querySelector('[role="note"]')
          ?.textContent?.trim(),
      ).toBe("Stored in this browser only.");
    }
    await select(menu, "view:reasoning");
    await select(menu, "view:tool-calls");
    await select(menu, "view:commentary");
    await select(menu, "view:speech-bubbles");
    expect(onSettingsChange.mock.calls).toEqual(
      onboarding
        ? []
        : [
            [{ chatShowThinking: false }],
            [{ chatShowToolCalls: false }],
            [{ chatPersistCommentary: false }],
            [
              {
                chatBubbleSessionKeys: ["agent:main:test"],
                chatBubbleDisabledSessionKeys: undefined,
              },
            ],
          ],
    );
  });

  it.each([false, true])("keeps bubble mode on the menu session in compact=%s", async (compact) => {
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const menu = await mountMenu({
      compact,
      bubbleModeEnabled: true,
      session: { target: { key: "agent:main:other" } },
      onSettingsChange,
    });
    menu.settings = { ...settings(), chatBubbleSessionKeys: ["agent:main:main"] };
    if (compact) {
      await select(menu, "compact:open-view");
    }
    await menu.updateComplete;
    const bubbleItem = item(menu, "Speech bubbles");
    expect(bubbleItem.getAttribute("aria-checked") === "true").toBe(false);
    await select(menu, "view:speech-bubbles");
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      chatBubbleSessionKeys: ["agent:main:main", "agent:main:other"],
      chatBubbleDisabledSessionKeys: undefined,
    });
    menu.settings = { ...menu.settings, ...onSettingsChange.mock.calls[0]![0] };
    await menu.updateComplete;
    // The open checkbox keeps its DOM identity and keyboard navigation position.
    expect(item(menu, "Speech bubbles")).toBe(bubbleItem);
    expect(bubbleItem.getAttribute("aria-checked") === "true").toBe(true);
    expect(bubbleItem.closest('[role="menu"]')?.matches(":popover-open")).toBe(true);
    menu.session = { ...menu.session, target: { key: "agent:main:third" } };
    await menu.updateComplete;
    expect(item(menu, "Speech bubbles").getAttribute("aria-checked") === "true").toBe(false);
    menu.session = { ...menu.session, target: { key: "agent:main:other" } };
    await menu.updateComplete;
    await select(menu, "view:speech-bubbles");
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      chatBubbleSessionKeys: ["agent:main:main"],
      chatBubbleDisabledSessionKeys: ["agent:main:other"],
    });
  });

  it.each([false, true])("renders and activates session actions in compact=%s", async (compact) => {
    const exportTranscript = vi.fn();
    const stopWorker = vi.fn();
    const onOpenCommandPalette = vi.fn();
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const currentOwner: HeaderMenuElement["currentOwner"] = { type: "agent", id: "research:one" };
    const menu = await mountMenu({
      compact,
      sessionActions: [
        {
          id: "plugin/export",
          label: "Export transcript",
          icon: "plug",
          onActivate: exportTranscript,
        },
        {
          id: "stop-cloud-worker",
          label: "Stop cloud worker",
          icon: "stop",
          variant: "danger",
          disabled: true,
          description: "Worker is restarting",
          onActivate: stopWorker,
        },
      ],
      ...(compact
        ? {
            worktreePath: "/work/openclaw",
            context: createSessionOwnerMenuHarness().context,
            currentOwner,
            onOpenCommandPalette,
            onSettingsChange,
            onAction,
          }
        : {}),
    });
    const navigate = async (value: string): Promise<void> => {
      const target = () => menu.querySelector(`[data-value="compact:${value}"]`);
      if (value === "back") {
        const back = menu.querySelector<HTMLButtonElement>(".session-menu__back");
        if (!back?.dataset.value) {
          throw new Error("Expected compact back action");
        }
        await select(menu, back.dataset.value);
        return;
      }
      if (!target() && menu.querySelector(".session-menu__back")) {
        await navigate("back");
      }
      if (!target()) {
        await select(menu, "compact:open-advanced");
      }
      await select(menu, `compact:${value}`);
    };
    const initialLabels = rootLabels(menu);
    expect(initialLabels).not.toContain("Panels");
    expect(initialLabels).not.toContain("Layout");
    const stopItem = item(menu, "Stop cloud workerWorker is restarting");
    expect(stopItem.disabled).toBe(true);
    expect(stopItem.getAttribute("data-variant")).toBe("danger");
    expect(stopItem.querySelector(".session-menu__description")?.textContent).toBe(
      "Worker is restarting",
    );
    await select(menu, "quick:plugin/export");
    await select(menu, "quick:stop-cloud-worker");
    expect(exportTranscript).toHaveBeenCalledOnce();
    expect(stopWorker).not.toHaveBeenCalled();
    if (compact) {
      expect(initialLabels).toEqual([
        "Open command palette",
        "View",
        "Pin session",
        "Rename…",
        "Mark as unread",
        "Copy link",
        "Assign to…",
        "Move to group",
        "Archive session",
        "Export transcript",
        "Stop cloud workerWorker is restarting",
        "Advanced",
      ]);
      expect(panel(menu).querySelector('[role="menu"]')).toBeNull();
      await select(menu, "open-command-palette");
      expect(onOpenCommandPalette).toHaveBeenCalledOnce();
      await navigate("open-copy");
      expect(rootLabels(menu)).toEqual([
        "Back",
        "Preview link",
        "Conversation as Markdown",
        "Session ID",
      ]);
      await navigate("back");
      await navigate("open-open-in");
      expect(rootLabels(menu)).toEqual([
        "Back",
        "New tab",
        "New window",
        "Continue in terminal…",
        "Cursor",
        "VS Code",
        "Windsurf",
        "Zed",
      ]);
      await navigate("back");
      await navigate("open-view");
      expect(rootLabels(menu)).toEqual(["Back", "Reasoning", "Tool calls", "Keep commentary"]);
      expect(panel(menu).querySelector('[role="menu"]')).toBeNull();
      await select(menu, "view:reasoning");
      expect(onSettingsChange).toHaveBeenCalledWith({ chatShowThinking: false });
      await navigate("back");
      await navigate("open-assign-owner");
      expect(rootLabels(menu)).toEqual(["Back", "Me", "Research"]);
      await select(menu, "assign-owner:human:profile-ada");
      expect(onAction).toHaveBeenCalledWith({
        kind: "assign-owner",
        owner: { type: "human", id: "profile-ada" },
      });
      expect(menu.openMenu()).toBe(true);
      flush();
      await menu.updateComplete;
      expect(rootLabels(menu)).toEqual(initialLabels);
    } else {
      expect(submenuItems(item(menu, "View")).map(itemLabel)).toEqual([
        "Reasoning",
        "Tool calls",
        "Keep commentary",
      ]);
    }
  });

  it("drills into session sharing only from the compact menu", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const sharing = {
      session: {
        key: "agent:main:shared",
        kind: "direct",
        updatedAt: 1,
        visibility: "draft",
        sharingRole: "owner",
      },
      state: {
        loading: false,
        result: {
          sessionKey: "agent:main:shared",
          owner: { type: "human", id: "owner", label: "Owner" },
          members: [],
          identities: [{ type: "human", id: "vyctor", label: "Vyctor" }],
          role: "owner",
          allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        },
      },
      onOpen,
      onVisibilityChange,
      onMemberChange: vi.fn(),
    } satisfies ChatSessionSharingProps;

    const desktop = await mountMenu({ sharing });
    expect(desktop.textContent).not.toContain("Session sharing");

    const compact = await mountMenu({ compact: true, sharing });
    await select(compact, "compact:open-sharing");
    await compact.updateComplete;
    expect(onOpen).toHaveBeenCalledOnce();
    expect(compact.querySelector(".chat-header-session-menu--compact-sharing") !== null).toBe(true);
    expect(rootLabels(compact)).toEqual([
      "Back",
      "Publish draft",
      "Read-only",
      "Suggest",
      "Draft",
      "Vyctor",
    ]);
    expect(
      compact.querySelector(".chat-pane__publish-draft")?.classList.contains("session-menu__item"),
    ).toBe(true);
    await select(compact, "visibility:read-only");
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  });

  it.each([false, true])(
    "honors action gating and bare-letter shortcuts (allowed=%s)",
    async (allowed) => {
      const onAction = vi.fn<(action: HeaderMenuAction) => void>();
      const menu = await mountMenu({
        actionDisabledReasons: { rename: "Operator write access is required." },
        archiveAllowed: false,
        deleteAllowed: false,
        copyMarkdownAllowed: allowed,
        splitAllowed: allowed,
        forkFromLastCompleted: true,
        onAction,
      });
      const dropdown = panel(menu);

      expect(item(menu, "Rename…").disabled).toBe(true);
      expect(item(menu, "Archive session").disabled).toBe(true);
      expect(item(menu, "Delete…").disabled).toBe(true);
      expect(item(menu, "Conversation as Markdown").disabled).toBe(!allowed);
      if (allowed) {
        expect(item(menu, "Split right").disabled).toBe(false);
      }
      expect(item(menu, "Fork conversation").getAttribute("title")).toBe(
        "Fork from last completed message",
      );
      const navigationActions = [
        "copy-session-link",
        "copy-session-preview-link",
        "open-new-tab",
        "open-new-window",
      ] as const;
      for (const kind of navigationActions) {
        await select(menu, kind);
      }
      expect(onAction.mock.calls).toEqual(navigationActions.map((kind) => [{ kind }]));
      onAction.mockClear();
      const gatedActions = ["copy-markdown", "split-right", "split-below"] as const;
      for (const kind of gatedActions) {
        if (!allowed && kind !== "copy-markdown") {
          expect(menu.querySelector(`[data-value="${kind}"]`)).toBeNull();
        } else {
          await select(menu, kind);
        }
      }
      expect(onAction.mock.calls).toEqual(allowed ? gatedActions.map((kind) => [{ kind }]) : []);
      onAction.mockClear();
      expect(menu.openMenu()).toBe(true);
      flush();
      dropdown.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }),
      );
      expect(onAction).toHaveBeenCalledWith({ kind: "fork" });
      onAction.mockClear();
      dropdown?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }),
      );
      expect(onAction).not.toHaveBeenCalled();
    },
  );

  it("emits terminal continuation only while the current Gateway is connected", async () => {
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const connected = await mountMenu({ onAction });

    expect(item(connected, "Continue in terminal…").disabled).toBe(false);
    const dropdown = panel(connected);
    await select(connected, "continue-in-terminal");
    expect(dropdown.matches(":popover-open")).toBe(false);
    expect(onAction).toHaveBeenCalledWith({ kind: "continue-in-terminal" });

    const disconnected = await mountMenu({
      actionDisabledReasons: { "continue-in-terminal": "Gateway disconnected." },
      onAction,
    });
    const disabledAction = item(disconnected, "Continue in terminal…");
    expect(disabledAction.disabled).toBe(true);
    expect(disabledAction.getAttribute("title")).toBe("Gateway disconnected.");
    onAction.mockClear();
    await select(disconnected, "continue-in-terminal");
    expect(onAction).not.toHaveBeenCalled();
  });
});
