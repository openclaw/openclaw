/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { UiSettings } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
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
import "./chat-header-session-menu.ts";
import type { ChatSessionSharingProps } from "./chat-session-sharing.ts";
import { openNativeSessionMenu } from "./native-session-menu.runtime.ts";

type HeaderMenuElement = HTMLElementTagNameMap["openclaw-chat-header-session-menu"];
type MenuItemElement = HTMLElement & { checked: boolean; disabled: boolean; submenuOpen?: boolean };

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

async function mountMenu({
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
    | "copyMarkdownAllowed"
    | "splitAllowed"
    | "panelActions"
    | "layoutActions"
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
} = {}): Promise<HeaderMenuElement> {
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
  return menu;
}

function itemLabel(menuItem: Element): string {
  return menuItem.querySelector(":scope > .session-menu__text")?.textContent?.trim() ?? "";
}

function rootLabels(menu: ParentNode): string[] {
  return Array.from(menu.querySelectorAll(":scope > wa-dropdown > wa-dropdown-item"), itemLabel);
}

function item(menu: ParentNode, label: string): MenuItemElement {
  const found = Array.from(menu.querySelectorAll<MenuItemElement>("wa-dropdown-item")).find(
    (candidate) => itemLabel(candidate) === label,
  );
  if (!found) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return found;
}

function select(menu: ParentNode, value: string) {
  menu.querySelector("wa-dropdown")?.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: { item: { value } },
    }),
  );
}

describe("chat header session menu", () => {
  it.each(["shown", "selected", "aborted", "retargeted"] as const)(
    "settles native opening only at the current popup boundary: %s",
    async (outcome) => {
      const menu = await mountMenu();
      const abort = new AbortController();
      let current = true;
      const settled = vi.fn();
      const opening = openNativeSessionMenu({
        pane: menu.parentElement!,
        signal: abort.signal,
        isCurrent: () => current,
      });
      void opening.then(settled);
      await menu.updateComplete;
      await Promise.resolve();
      const dropdown = menu.querySelector("wa-dropdown")!;
      await dropdown.updateComplete;
      expect(dropdown.open).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      if (outcome === "selected") {
        dropdown.dispatchEvent(
          new CustomEvent("wa-select", { cancelable: true, detail: { item: { value: "rename" } } }),
        );
        dropdown.open = false;
        dropdown.dispatchEvent(new Event("wa-hide"));
      } else if (outcome === "aborted") {
        abort.abort();
      } else {
        current = outcome === "shown";
        dropdown.dispatchEvent(new Event("wa-after-show"));
      }
      expect(await opening).toBe(outcome === "shown" || outcome === "selected");
      expect(dropdown.open).toBe(outcome === "shown");
      abort.abort();
      expect(dropdown.open).toBe(outcome === "shown");
    },
  );

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
          .querySelector('[value="toggle-archived"] .session-menu__shortcut')
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
        expect(menu.querySelector('[value="toggle-involving-me"]') !== null).toBe(multiple);
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
      const client = {
        gatewayUrl: "gatewayUrl" in testCase ? testCase.gatewayUrl : "ws://localhost:18789",
      } as GatewayBrowserClient;
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
      render(
        pane.renderPaneHeader(
          createPaneHeaderWorkspaceFixture(state),
          session,
          false,
          undefined,
          false,
          null,
        ),
        container,
      );
      const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
      await menu?.updateComplete;

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
    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
    const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
    if (!menu) {
      throw new Error("Expected chat header session menu");
    }
    await menu.updateComplete;

    const moveToGroup = item(menu, "Move to group");
    const groupLabels = Array.from(
      moveToGroup.querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
    ).map(itemLabel);
    expect(groupLabels).toEqual(["Catalog", "Discovered", "New group"]);
  });

  it.each([false, true])("gates view preferences during onboarding=%s", async (onboarding) => {
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const menu = await mountMenu({
      onboarding,
      preferencesBrowserOnly: !onboarding,
      session: { target: { key: "agent:main:test" } },
      onSettingsChange,
    });
    const view = item(menu, "View");
    const viewItems = Array.from(
      view.querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
    );

    expect(viewItems.map(itemLabel)).toEqual([
      "Reasoning",
      "Tool calls",
      "Keep commentary",
      "Speech bubbles",
    ]);
    expect(viewItems.map((entry) => entry.checked)).toEqual([!onboarding, true, true, false]);
    if (onboarding) {
      expect(viewItems.every((entry) => entry.disabled)).toBe(true);
      expect(
        viewItems.every((entry) => entry.getAttribute("title") === "Disabled during setup"),
      ).toBe(true);
    } else {
      expect(view.querySelector('[role="note"]')?.textContent?.trim()).toBe(
        "Stored in this browser only.",
      );
    }
    select(menu, "view:reasoning");
    select(menu, "view:tool-calls");
    select(menu, "view:commentary");
    select(menu, "view:speech-bubbles");
    expect(onSettingsChange.mock.calls).toEqual(
      onboarding
        ? []
        : [
            [{ chatShowThinking: false }],
            [{ chatShowToolCalls: false }],
            [{ chatPersistCommentary: false }],
            [{ chatBubbleSessionKeys: ["agent:main:test"] }],
          ],
    );
  });

  it.each([false, true])("keeps bubble mode on the menu session in compact=%s", async (compact) => {
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const menu = await mountMenu({
      compact,
      session: { target: { key: "agent:main:other" } },
      onSettingsChange,
    });
    menu.settings = { ...settings(), chatBubbleSessionKeys: ["agent:main:main"] };
    if (compact) {
      select(menu, "compact:open-view");
    }
    await menu.updateComplete;
    const bubbleItem = item(menu, "Speech bubbles");
    expect(bubbleItem.checked).toBe(false);
    select(menu, "view:speech-bubbles");
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      chatBubbleSessionKeys: ["agent:main:main", "agent:main:other"],
    });
    menu.settings = { ...menu.settings, ...onSettingsChange.mock.calls[0]![0] };
    await menu.updateComplete;
    // The open checkbox keeps its DOM identity and keyboard navigation position.
    expect(item(menu, "Speech bubbles")).toBe(bubbleItem);
    expect(bubbleItem.checked).toBe(true);
    menu.session = { ...menu.session, target: { key: "agent:main:third" } };
    await menu.updateComplete;
    expect(item(menu, "Speech bubbles").checked).toBe(false);
    menu.session = { ...menu.session, target: { key: "agent:main:other" } };
    await menu.updateComplete;
    select(menu, "view:speech-bubbles");
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      chatBubbleSessionKeys: ["agent:main:main"],
    });
  });

  it.each([false, true])(
    "renders and activates session menu groups in compact=%s",
    async (compact) => {
      const showFiles = vi.fn();
      const showChanges = vi.fn();
      const splitRight = vi.fn();
      const onOpenCommandPalette = vi.fn();
      const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
      const onAction = vi.fn<(action: HeaderMenuAction) => void>();
      const currentOwner: HeaderMenuElement["currentOwner"] = { type: "agent", id: "research:one" };
      const menu = await mountMenu({
        compact,
        panelActions: [
          {
            id: "session-files",
            label: "Show session files",
            icon: icons.listChecks,
            ...(compact ? {} : { active: false }),
            badge: 2,
            onActivate: showFiles,
          },
          ...(compact
            ? []
            : [
                {
                  id: "changes",
                  label: "Show session changes",
                  icon: icons.diff,
                  onActivate: showChanges,
                },
              ]),
        ],
        layoutActions: [
          {
            id: "split-right",
            label: "Split right",
            icon: icons.panelRightOpen,
            onActivate: splitRight,
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
      const navigate = async (value: string) => {
        select(menu, `compact:${value}`);
        await menu.updateComplete;
      };
      const initialLabels = rootLabels(menu);
      if (compact) {
        expect(initialLabels).toEqual([
          "Open command palette",
          "Panels",
          "Layout",
          "View",
          "Pin session",
          "Rename…",
          "Mark as unread",
          "Copy link",
          "Assign to…",
          "Move to group",
          "Archive session",
          "Advanced",
        ]);
        expect(menu.querySelector("[slot='submenu']")).toBeNull();
        select(menu, "open-command-palette");
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
        expect(rootLabels(menu)).toEqual([
          "Back",
          "Reasoning",
          "Tool calls",
          "Keep commentary",
          "Speech bubbles",
        ]);
        expect(menu.querySelector("[slot='submenu']")).toBeNull();
        select(menu, "view:reasoning");
        expect(onSettingsChange).toHaveBeenCalledWith({ chatShowThinking: false });
        await navigate("back");
        await navigate("open-panels");
      } else {
        const panelItems = Array.from(
          item(menu, "Panels").querySelectorAll<MenuItemElement>(
            "wa-dropdown-item[slot='submenu']",
          ),
        );
        expect(panelItems.map(itemLabel)).toEqual(["Show session files", "Show session changes"]);
        expect(panelItems[0]?.checked).toBe(false);
        expect(
          Array.from(
            item(menu, "Layout").querySelectorAll<MenuItemElement>(
              "wa-dropdown-item[slot='submenu']",
            ),
          ).map(itemLabel),
        ).toEqual(["Split right"]);
      }
      expect(
        item(menu, "Show session files").querySelector('[slot="details"]')?.textContent?.trim(),
      ).toBe("2");
      select(menu, "quick:panels:session-files");
      expect(showFiles).toHaveBeenCalledOnce();
      if (compact) {
        await navigate("open-assign-owner");
        expect(rootLabels(menu)).toEqual(["Back", "Me", "Research"]);
        select(menu, "assign-owner:human:profile-ada");
        expect(onAction).toHaveBeenCalledWith({
          kind: "assign-owner",
          owner: { type: "human", id: "profile-ada" },
        });
        menu.querySelector("wa-dropdown")!.dispatchEvent(new Event("wa-show"));
        await menu.updateComplete;
        expect(rootLabels(menu)).toEqual(initialLabels);
      } else {
        select(menu, "quick:panels:changes");
        select(menu, "quick:layout:split-right");
        expect(showChanges).toHaveBeenCalledOnce();
        expect(splitRight).toHaveBeenCalledOnce();
      }
    },
  );

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
    select(compact, "compact:open-sharing");
    await compact.updateComplete;
    expect(onOpen).toHaveBeenCalledOnce();
    expect(
      compact
        .querySelector("wa-dropdown")
        ?.classList.contains("chat-header-session-menu--compact-sharing"),
    ).toBe(true);
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
    select(compact, "visibility:read-only");
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
      const dropdown = menu.querySelector("wa-dropdown");

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
        select(menu, kind);
      }
      expect(onAction.mock.calls).toEqual(navigationActions.map((kind) => [{ kind }]));
      onAction.mockClear();
      const gatedActions = ["copy-markdown", "split-right", "split-below"] as const;
      for (const kind of gatedActions) {
        select(menu, kind);
      }
      expect(onAction.mock.calls).toEqual(allowed ? gatedActions.map((kind) => [{ kind }]) : []);
      onAction.mockClear();
      dropdown?.dispatchEvent(
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
    const dropdown = connected.querySelector("wa-dropdown") as HTMLElement & { open: boolean };
    dropdown.open = true;
    select(connected, "continue-in-terminal");
    expect(dropdown.open).toBe(false);
    expect(onAction).toHaveBeenCalledWith({ kind: "continue-in-terminal" });

    const disconnected = await mountMenu({
      actionDisabledReasons: { "continue-in-terminal": "Gateway disconnected." },
      onAction,
    });
    const disabledAction = item(disconnected, "Continue in terminal…");
    expect(disabledAction.disabled).toBe(true);
    expect(disabledAction.getAttribute("title")).toBe("Gateway disconnected.");
    onAction.mockClear();
    select(disconnected, "continue-in-terminal");
    expect(onAction).not.toHaveBeenCalled();
  });
});
