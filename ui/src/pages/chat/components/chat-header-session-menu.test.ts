/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import type { UiSettings } from "../../../app/settings.ts";
import { profileDirectory } from "../../../lib/profile-directory.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createSessionOwnerMenuHarness } from "../../../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import type { HeaderMenuAction, HeaderMenuProps } from "./chat-header-session-menu.tsx";
import {
  chatPaneHeaderSessionRow as row,
  renderPaneHeaderInto,
} from "./chat-pane-header.test-support.ts";
import "./chat-header-session-menu.ts";
import type { ChatSessionSharingProps } from "./chat-session-sharing-shared.tsx";
import { openNativeSessionMenu } from "./native-session-menu.runtime.ts";

type HeaderMenuElement = HTMLElementTagNameMap["openclaw-chat-header-session-menu"];
const containers: HTMLElement[] = [];
const shortcut = (menuItem: Element, compact = false) => {
  const text = menuItem.querySelector(".session-menu__shortcut")?.textContent;
  return (compact ? text?.replace(/\s+/gu, "") : text)?.trim();
};

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  vi.restoreAllMocks();
});

const settings = (): HeaderMenuElement["settings"] => ({
  chatShowThinking: true,
  chatShowToolCalls: true,
  chatPersistCommentary: true,
});
const query = (root: ParentNode, selector: string): HTMLButtonElement =>
  expectDefined(root.querySelector<HTMLButtonElement>(selector), selector);
const panel = (menu: ParentNode) =>
  expectDefined(
    menu.querySelector<HTMLElement>(".chat-header-session-menu__panel"),
    "session menu panel",
  );
const itemLabel = (item: Element) =>
  item.querySelector(".session-menu__text")?.textContent?.trim() ??
  item.getAttribute("aria-label") ??
  "";
const rows = (root: ParentNode) => [
  ...root.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
];
const item = (menu: ParentNode, label: string) =>
  expectDefined(
    rows(menu).find((candidate) => itemLabel(candidate) === label),
    label,
  );
const submenu = (trigger: HTMLElement) =>
  expectDefined(document.getElementById(trigger.getAttribute("aria-controls") ?? ""), "submenu");
const submenuItems = (trigger: HTMLElement) => {
  const root = submenu(trigger);
  return rows(root).filter((candidate) => candidate.closest('[role="menu"]') === root);
};
const press = (root: HTMLElement, key: string) =>
  root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

async function mountMenu(
  {
    context,
    session,
    ...properties
  }: Partial<Omit<HeaderMenuProps, "session">> & {
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
    await openMenu(menu);
    await materializeSubmenus(menu);
    await menu.updateComplete;
  }
  return menu;
}

async function openMenu(menu: HeaderMenuElement) {
  expect(menu.openMenu()).toBe(true);
  await waitForSolid(() => expect(menu.querySelector('[data-value="rename"]')).not.toBeNull());
}

function whenHidden(menu: HeaderMenuElement) {
  return new Promise<void>((resolve) => {
    const hidden = (event: Event) => {
      if (event.target === panel(menu)) {
        panel(menu).removeEventListener("overlay-after-hide", hidden);
        resolve();
      }
    };
    panel(menu).addEventListener("overlay-after-hide", hidden);
  });
}

async function expectParked(menu: HeaderMenuElement, update: () => void) {
  const changes: MutationRecord[] = [];
  const mutations = new MutationObserver((records) => changes.push(...records));
  mutations.observe(panel(menu), { childList: true, subtree: true, attributes: true });
  update();
  await menu.updateComplete;
  flush();
  expect([...changes, ...mutations.takeRecords()]).toEqual([]);
  mutations.disconnect();
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
      const branch = submenu(trigger);
      await visit(branch);
      if (branch.matches(":popover-open")) {
        trigger.click();
        flush();
      }
    }
  };
  await visit(panel(menu));
}

async function select(menu: HeaderMenuElement, value: string) {
  await menu.updateComplete;
  if (!panel(menu).matches(":popover-open")) {
    await openMenu(menu);
  }
  const target = query(menu, `[data-value="${value}"]`);
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

it("focuses the current first row when reopening removes the parked first row", async () => {
  const menu = await mountMenu({}, false);
  await openMenu(menu);
  const previousFirst = item(menu, "Command palette");
  const trigger = menu.readTrigger()!;
  const hidden = whenHidden(menu);
  press(panel(menu), "Escape");
  flush();
  await hidden;
  await expectParked(menu, () => {
    menu.mobile = false;
  });
  expect(previousFirst.isConnected).toBe(true);

  trigger.focus();
  expect(menu.openMenu()).toBe(true);
  expect(document.activeElement).toBe(previousFirst);
  await waitForSolid(() => {
    expect(previousFirst.isConnected).toBe(false);
    expect(document.activeElement).toBe(item(menu, "View"));
  });
});

it("reconciles parked owner membership and labels without replacing surviving rows", async () => {
  const owner = createSessionOwnerMenuHarness();
  owner.context.agents.state.agentsList!.agents.push({ id: "retired", name: "Retired" });
  const menu = await mountMenu({ context: owner.context }, false);
  await openMenu(menu);
  item(menu, "Assign to…").click();
  flush();
  await profileDirectory(owner.context.gateway).load();
  await menu.updateComplete;
  const research = item(menu, "Research");
  const self = item(menu, "Me");
  const hidden = whenHidden(menu);
  menu.querySelector<HTMLButtonElement>(".chat-header-session-menu__trigger")!.click();
  await menu.updateComplete;
  expect(panel(menu).matches(":popover-open")).toBe(false);
  await hidden;
  await expectParked(menu, () => {
    owner.context.agents.state.agentsList!.agents = [
      { id: "research:one", name: "Updated research" },
      { id: "new", name: "New agent" },
    ];
    owner.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
  });
  await openMenu(menu);
  expect(item(menu, "Updated research")).toBe(research);
  expect(item(menu, "Me")).toBe(self);
  expect(
    submenuItems(item(menu, "Assign to…"))
      .filter((option) => option.value.startsWith("assign-owner:"))
      .map(itemLabel),
  ).toEqual(["Me", "New agent", "Updated research"]);
});

it.each(["shown", "aborted", "retargeted"] as const)(
  "opens only a current native popup request: %s",
  async (outcome) => {
    const onAction = vi.fn();
    const menu = await mountMenu({ onAction }, false);
    const abort = new AbortController();
    if (outcome === "aborted") {
      abort.abort();
    }
    const opened = await openNativeSessionMenu({
      pane: menu.parentElement!,
      getMenu: () => menu,
      signal: abort.signal,
      isCurrent: () => outcome !== "retargeted",
    });
    expect(opened).toBe(outcome === "shown");
    expect(panel(menu).matches(":popover-open")).toBe(outcome === "shown");
    abort.abort();
    expect(panel(menu).matches(":popover-open")).toBe(outcome === "shown");
    if (outcome === "shown") {
      await select(menu, "rename");
      expect(onAction).toHaveBeenCalledWith({ kind: "rename" });
    }
    expect(panel(menu).matches(":popover-open")).toBe(false);
  },
);

it.each(["MacIntel", "Win32"])(
  "shows the direct Archive hint only for the current unarchived chat on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const menu = await mountMenu({ archiveShortcut: true });
    expect(shortcut(item(menu, "Archive session"), true)).toBe(
      platform === "MacIntel" ? "A/⌘⇧A" : "A/Ctrl+Shift+A",
    );
    menu.archiveShortcut = false;
    await menu.updateComplete;
    expect(shortcut(item(menu, "Archive session"))).toBe("A");
    menu.archiveShortcut = true;
    menu.session = { ...menu.session, archived: true };
    await menu.updateComplete;
    expect(shortcut(menu.querySelector('[data-value="toggle-archived"]')!)).toBe("A");
  },
);

it("preserves row-discovered groups when the gateway catalog lags", async () => {
  const session = row({ key: "agent:main:current" });
  const sessions = createSessionCapabilityFixture({
    state: {
      error: null,
      groups: ["Catalog"],
      result: {
        count: 2,
        path: "",
        ts: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [session, row({ key: "agent:main:discovered", category: "Discovered" })],
      },
    },
  });
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions,
  });
  state.settings = {} as ChatPageHost["settings"];
  const container = document.body.appendChild(document.createElement("div"));
  containers.push(container);
  renderPaneHeaderInto(
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
  const menu = expectDefined(
    container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu"),
    "session menu",
  );
  await menu.updateComplete;
  await openMenu(menu);
  await materializeSubmenus(menu);
  expect(submenuItems(item(menu, "Move to group")).map(itemLabel)).toEqual([
    "Catalog",
    "Discovered",
    "New group",
  ]);
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
    expect(query(submenu(view), '[role="note"]').textContent?.trim()).toBe(
      "Stored in this browser only.",
    );
  }
  for (const value of ["reasoning", "tool-calls", "commentary", "speech-bubbles"]) {
    await select(menu, `view:${value}`);
  }
  expect(onSettingsChange.mock.calls.map(([patch]) => patch)).toEqual(
    onboarding
      ? []
      : [
          { chatShowThinking: false },
          { chatShowToolCalls: false },
          { chatPersistCommentary: false },
          { chatBubbleSessionKeys: ["agent:main:test"], chatBubbleDisabledSessionKeys: undefined },
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
    onOpenCommandPalette,
    onSettingsChange,
  });
  const stopItem = item(menu, "Stop cloud workerWorker is restarting");
  expect(stopItem.disabled).toBe(true);
  expect(stopItem.getAttribute("data-variant")).toBe("danger");
  expect(stopItem.textContent).toContain("Worker is restarting");
  await select(menu, "quick:plugin/export");
  await select(menu, "quick:stop-cloud-worker");
  expect(exportTranscript).toHaveBeenCalledOnce();
  expect(stopWorker).not.toHaveBeenCalled();
  if (compact) {
    await select(menu, "open-command-palette");
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    await select(menu, "compact:open-view");
    await select(menu, "view:reasoning");
    expect(onSettingsChange).toHaveBeenCalledWith({ chatShowThinking: false });
    await select(menu, "compact:back");
    expect(item(menu, "Export transcript")).toBeDefined();
  }
});

it("drills into session sharing only from the compact menu", async () => {
  const onOpen = vi.fn();
  const onVisibilityChange = vi.fn();
  const onMemberChange = vi.fn();
  const sharing: ChatSessionSharingProps = {
    session: row({ visibility: "draft", sharingRole: "owner" }),
    state: {
      loading: false,
      result: {
        sessionKey: "agent:main:test",
        members: [],
        identities: [{ type: "human", id: "vyctor", label: "Vyctor" }],
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      },
    },
    onOpen,
    onVisibilityChange,
    onMemberChange,
  };

  const desktop = await mountMenu({ sharing });
  expect(desktop.textContent).not.toContain("Session sharing");

  const compact = await mountMenu({ compact: true, sharing });
  const publish = async (loading: boolean, level: "read" | "send", error?: string) => {
    compact.sharing = {
      ...sharing,
      session: { ...sharing.session!, visibility: "read-only" },
      state: {
        loading,
        error,
        result: {
          ...sharing.state!.result!,
          permissions: [{ identityId: "vyctor", level, options: ["read", "send"] }],
        },
      },
    };
    await compact.updateComplete;
  };
  await select(compact, "compact:open-sharing");
  await compact.updateComplete;
  expect(onOpen).toHaveBeenCalledOnce();
  expect(compact.querySelector(".chat-header-session-menu--compact-sharing") !== null).toBe(true);
  await select(compact, "visibility:read-only");
  expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  expect(compact.textContent).not.toContain("Vyctor");
  await publish(false, "read");
  await select(compact, "compact:open-sharing");
  await select(compact, "permission:vyctor");
  const permission = query(compact, '[data-value="permission:vyctor"]');
  const send = query(compact, '[data-value="permission:send:vyctor"]');
  await select(compact, "permission:send:vyctor");
  send.focus();
  expect(document.activeElement).toBe(send);
  expect(onMemberChange).toHaveBeenCalledExactlyOnceWith("vyctor", true);
  await publish(true, "read");
  expect(permission.isConnected).toBe(true);
  expect(permission.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(send);
  send.click();
  expect(onMemberChange).toHaveBeenCalledTimes(1);
  await publish(false, "send");
  expect(document.activeElement).toBe(send);
  expect(send.getAttribute("aria-checked")).toBe("true");

  const read = query(compact, '[data-value="permission:read:vyctor"]');
  read.focus();
  read.click();
  expect(onMemberChange).toHaveBeenLastCalledWith("vyctor", false);
  await publish(true, "send");
  expect(document.activeElement).toBe(read);
  await publish(false, "send", "Permission changed");
  expect(document.activeElement).toBe(read);
  expect(send.getAttribute("aria-checked")).toBe("true");
  expect(compact.textContent).toContain("Permission changed");
});

it("routes header shortcuts through the action gate", async () => {
  const onAction = vi.fn<(action: HeaderMenuAction) => void>();
  const menu = await mountMenu({
    actionDisabledReasons: { rename: "Operator write access is required." },
    onAction,
  });
  const dropdown = panel(menu);
  press(dropdown, "f");
  expect(onAction).toHaveBeenCalledWith({ kind: "fork" });
  onAction.mockClear();
  press(dropdown, "r");
  expect(onAction).not.toHaveBeenCalled();
});

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
