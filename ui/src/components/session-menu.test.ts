/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createShellOwner } from "../app/app-host-solid.test-support.ts";
import { i18n } from "../i18n/index.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../test-helpers/app-sidebar.ts";
import type { ApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  containers,
  mountMenu,
  menuItemLabels,
  menuItem,
  iconChoices,
  selectMenuValue,
  menuPanel,
  openSubmenu,
  settleSessionMenu,
} from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { SessionMenuAction } from "./session-menu-solid.tsx";

function press(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

function focusButton() {
  const button = document.createElement("button");
  document.body.append(button);
  containers.push(button);
  return button;
}

async function reopen(menu: Awaited<ReturnType<typeof mountMenu>>) {
  menu.anchor = { ...menu.anchor };
  await settleSessionMenu(menu);
}

async function openAdvanced(menu: ParentNode, label: string) {
  return openSubmenu(await openSubmenu(menu, "Advanced"), label);
}

function queryButton(menu: ParentNode, selector: string) {
  return menu.querySelector<HTMLButtonElement>(selector);
}

function expectLabels(menu: ParentNode, expected: readonly string[]) {
  expect(menuItemLabels(menu)).toEqual(expected);
}
function waitForOwners(menu: ParentNode, labels: readonly string[]) {
  return waitForFast(() => expectLabels(menuItem(menu, "Assign to…"), labels));
}

async function actionMenu(options: Parameters<typeof mountMenu>[0] = {}) {
  const onAction = vi.fn<(action: SessionMenuAction) => void>();
  const onClose = vi.fn();
  return { menu: await mountMenu({ ...options, onAction, onClose }), onAction, onClose };
}

describe("session menu", () => {
  it("updates a mounted menu when the locale changes", async () => {
    await i18n.setLocale("en");
    onTestFinished(() => i18n.setLocale("en"));
    const menu = await mountMenu();
    const rename = queryButton(menu, '[data-value="rename"]')!;
    const englishLabel = rename.getAttribute("aria-label");

    await i18n.setLocale("de");
    const translatedLabel = i18n.t("sessionsView.renameSessionMenu");
    expect(translatedLabel).not.toBe(englishLabel);
    await waitForSolid(() => expect(rename.getAttribute("aria-label")).toBe(translatedLabel));
    expect(menu.querySelector('[data-value="rename"]')).toBe(rename);
  });

  it("keeps self, agents, and the current owner while the directory loads, then retries a visible failure", async () => {
    const pending = deferred<ReturnType<typeof sessionOwnerProfiles>>();
    const { context, request } = createSessionOwnerMenuHarness(() => sessionOwnerProfiles("Ada"));
    await profileDirectory(context.gateway).load();
    request.mockImplementation(() => pending.promise);
    const menu = await mountMenu({
      context,
      currentOwner: {
        type: "human",
        id: "profile-old-bob",
        identity: { type: "profile", id: "profile-bob" },
        label: "Bob",
      },
    });
    const expectCurrentOwner = () => {
      expect
        .soft(menuItemLabels(menuItem(menu, "Assign to…")).slice(0, 3))
        .toEqual(["Me", "Research", "Bob"]);
      const selected = queryButton(menu, 'button[role="menuitemradio"][aria-checked="true"]');
      expect.soft(selected?.getAttribute("value")).toBe("assign-owner:human:profile-bob");
      expect.soft(selected?.disabled).toBe(true);
    };
    await waitForFast(() => expect(request).toHaveBeenCalledWith("users.list", {}));
    expect(menu.textContent).toContain("Loading");
    expectCurrentOwner();

    pending.reject(new Error("Directory is temporarily unavailable."));
    await waitForFast(() =>
      expect(menu.querySelector('[role="alert"]')?.textContent).toContain(
        "Directory is temporarily unavailable.",
      ),
    );
    expectCurrentOwner();
    request.mockImplementation(() => sessionOwnerProfiles("Ada", "Bob", "Carol"));
    await openSubmenu(menu, "Assign to…");
    await selectMenuValue(menu, "reload-owners");
    await waitForOwners(menu, ["Me", "Research", "Bob", "Carol"]);
    expect(menu.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["reconnect", "replace gateway"] as const)(
    "retires pending owners on %s",
    async (transition) => {
      const pending = deferred<ReturnType<typeof sessionOwnerProfiles>>();
      const first = createSessionOwnerMenuHarness(() => pending.promise);
      const menu = await mountMenu({ context: first.context });
      await waitForFast(() => expect(first.request).toHaveBeenCalledWith("users.list", {}));
      if (transition === "reconnect") {
        first.request.mockImplementation(() => sessionOwnerProfiles("Carol"));
        first.publish({ phase: "reconnecting" });
        first.publish({ phase: "connected" });
      } else {
        const next = createSessionOwnerMenuHarness(() => sessionOwnerProfiles("Carol"));
        (menu.parentElement as ApplicationContextProvider).setContext(next.context);
      }
      await waitForOwners(menu, ["Me", "Research", "Carol"]);
      pending.resolve(sessionOwnerProfiles("Bob"));
      await pending.promise;
      await settleSessionMenu(menu);
      expectLabels(menuItem(menu, "Assign to…"), ["Me", "Research", "Carol"]);
    },
  );

  it.each(["agent", "human"] as const)("resolves canonical %s owners", async (type) => {
    const currentOwner =
      type === "agent"
        ? { type, id: "research:one" }
        : {
            type,
            id: "profile-merged-colleague",
            identity: { type: "profile" as const, id: "research:one" },
          };
    const [selectedLabel, otherLabel, otherType] =
      type === "agent"
        ? (["Research", "Colleague", "human"] as const)
        : (["Colleague", "Research", "agent"] as const);
    const profiles = sessionOwnerProfiles("Colleague", "Zed", "Merged colleague").profiles;
    Object.assign(profiles[0]!, { id: "research:one" });
    Object.assign(profiles[1]!, { displayName: "  ", emails: ["zed@example.test"] });
    Object.assign(profiles[2]!, { mergedInto: "research:one" });
    const { context } = createSessionOwnerMenuHarness(() => ({ profiles }));
    const { menu, onAction, onClose } = await actionMenu({ context, currentOwner });
    await waitForOwners(menu, ["Me", "Research", "Colleague", "zed@example.test"]);
    const selected = menuItem(menu, selectedLabel);
    await waitForSolid(() => expect(selected.getAttribute("role")).toBe("menuitemradio"));
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected).toMatchObject({ disabled: true });
    const other = menuItem(menu, otherLabel);
    expect(other.getAttribute("aria-checked")).toBe("false");
    expect(other.disabled).toBe(false);

    await openSubmenu(menu, "Assign to…");
    await selectMenuValue(menu, other.getAttribute("value")!);
    expect(onAction).toHaveBeenCalledWith({
      kind: "assign-owner",
      owner: { type: otherType, id: "research:one" },
    });
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onAction.mock.invocationCallOrder[0]!);

    const batch = await mountMenu({ selectionCount: 2, context });
    expect(batch.textContent).not.toContain("Assign to");
  });

  it.each([
    ["self only", ["Ada"], [], false],
    ["two offline people", ["Ada", "Bob"], [], true],
    ["one human and an agent", ["Ada"], ["research:one"], true],
    ["duplicate and merged profiles", ["Ada", "Ada", "Merged"], [], false],
    ["typed identity collision", ["Ada"], ["profile-ada"], true],
  ] as const)("gates assignment for %s", async (_name, names, agents, expected) => {
    const profiles = sessionOwnerProfiles(...names);
    for (const profile of profiles.profiles) {
      if (profile.displayName === "Merged") {
        profile.mergedInto = "profile-ada";
      }
    }
    const owner = createSessionOwnerMenuHarness(() => profiles);
    owner.context.agents.state.agentsList!.agents = agents.map((id) => ({ id }));
    const menu = await mountMenu({ context: owner.context });
    await waitForFast(() => expect(owner.request).toHaveBeenCalledWith("users.list", {}));
    await waitForFast(() => expect(menu.textContent).not.toContain("Loading"));
    expect(menuItemLabels(menu).includes("Assign to…")).toBe(expected);
  });

  it("keeps known assignees while refreshing and coalesces repeated opens", async () => {
    const owner = createSessionOwnerMenuHarness(() => sessionOwnerProfiles("Ada", "Bob"));
    owner.context.agents.state.agentsList!.agents = [];
    const menu = await mountMenu({ context: owner.context });
    await waitForFast(() => expect(menuItemLabels(menu)).toContain("Assign to…"));
    const pending = deferred<ReturnType<typeof sessionOwnerProfiles>>();
    owner.request.mockImplementation(() => pending.promise);
    for (let opening = 0; opening < 2; opening += 1) {
      await reopen(menu);
    }
    expect(owner.request).toHaveBeenCalledTimes(2);
    expect(menuItemLabels(menu)).toContain("Assign to…");
    pending.resolve(sessionOwnerProfiles("Ada"));
    await waitForFast(() => expect(menuItemLabels(menu)).not.toContain("Assign to…"));
  });

  it.each([
    [{}, "toggle-archived", { kind: "toggle-archived" }],
    [{ cloudWorkerStopAllowed: true }, "stop-cloud-worker", { kind: "stop-cloud-worker" }],
    [
      { pluginActions: [{ id: "review/open", label: "Open review" }] },
      "plugin:review/open",
      { kind: "plugin", id: "review/open" },
    ],
  ] as const)("dispatches root action %s", async (options, value, action) => {
    const { menu, onAction, onClose } = await actionMenu(options);
    await selectMenuValue(menu, value);
    expect(onAction).toHaveBeenCalledWith(action);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onAction.mock.invocationCallOrder[0]!);
  });

  it("disables only denied mutation actions and ignores disabled clicks", async () => {
    const { menu, onAction } = await actionMenu({
      actionDisabledReasons: {
        delete: "This action requires operator.admin access.",
        "toggle-pin": "This action requires operator.write access.",
      },
    });
    const pin = menuItem(menu, "Pin session");
    const deleteItem = menuItem(menu, "Delete…");

    expect(pin.disabled).toBe(true);
    expect(pin.getAttribute("title")).toBe("This action requires operator.write access.");
    expect(deleteItem.disabled).toBe(true);
    await openSubmenu(menu, "Advanced");
    deleteItem.click();
    pin.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "adds sessions to sections through the unchanged native menu (compact=%s)",
    async (compact) => {
      const key = compact ? "agent:main:research" : "main";
      const agentId = compact ? "main" : "research";
      const gateway = createGatewayHarness(
        createTestGatewayClient(
          vi.fn(async (method, params) =>
            method === "sessions.describe"
              ? {
                  session:
                    params &&
                    typeof params === "object" &&
                    "agentId" in params &&
                    params.agentId === agentId
                      ? {
                          key,
                          agentId,
                          sessionId: "session-123",
                          kind: "direct",
                          label: "Research",
                          updatedAt: 1,
                        }
                      : null,
                }
              : sessionOwnerProfiles(),
          ),
        ),
      );
      const sessions = createSessionsHarness("main", [key]);
      const context = createContext(gateway.gateway, sessions.sessions);
      context.navigation.update({
        personalSessionGroups: [{ id: "focus", label: "Focus", sessionKeys: [] }],
      });
      const { menu, onAction } = await actionMenu({
        compact,
        context,
        session: { target: { key, agentId }, pinnable: true, category: "Engineering" },
        actionDisabledReasons: { "move-to-group": "This action requires operator.write access." },
      });
      expect(menuItemLabels(menu)).toEqual([
        "Pin session",
        "Rename…",
        "Mark as unread",
        "Copy link",
        "Move to group",
        "Add to section",
        "Archive session",
        "Advanced",
      ]);
      expect(menuItem(menu, "Move to group").disabled).toBe(true);
      if (compact) {
        await selectMenuValue(menu, "compact:open-collections");
      } else {
        await openSubmenu(menu, "Add to section");
      }
      if (compact) {
        expect(menuItemLabels(menu)).toEqual(["Back", "Focus", "New section"]);
        expect(menuPanel(menu).querySelector('[role="menu"]')).toBeNull();
        await selectMenuValue(menu, "compact:back");
        expect(menuItemLabels(menu)).toContain("Move to group");
        await selectMenuValue(menu, "compact:open-collections");
      }
      await selectMenuValue(menu, "personal-collection:focus");
      await waitForFast(() =>
        expect(context.navigation.snapshot.personalSessionGroups).toEqual([
          { id: "focus", label: "Focus", sessionKeys: [key] },
        ]),
      );
      expect(menu.session.category).toBe("Engineering");
      expect(onAction).not.toHaveBeenCalled();
      expect(sessions.patch).not.toHaveBeenCalled();
      expect(sessions.groupsPut).not.toHaveBeenCalled();
    },
  );

  it("navigates compact groups without side flyouts", async () => {
    const menu = await mountMenu({ compact: true, groups: ["Research"] });
    for (const view of ["copy", "open-in", "icon", "group"] as const) {
      const advanced = view !== "group";
      if (advanced) {
        await selectMenuValue(menu, "compact:open-advanced");
      }
      await selectMenuValue(menu, `compact:open-${view}`);
      await settleSessionMenu(menu);
      expect(menuPanel(menu).querySelector('[role="menu"]')).toBeNull();
      expect(menuItemLabels(menu)[0]).toBe("Back");
      await selectMenuValue(menu, advanced ? "compact:back-advanced" : "compact:back");
      if (advanced) {
        await selectMenuValue(menu, "compact:back");
      }
    }
  });

  it.each([
    [{ session: { isChild: true } }, "Move to top level"],
    [{ selectionCount: 3 }, "Mark 3 as unread"],
    [{ selectionCount: 2, session: { unread: true } }, "Mark 2 as read"],
    [{ selectionCount: 2, session: { archived: true } }, "Restore 2"],
  ] as const)("shows the state-specific action %s", async (options, label) => {
    const menu = await mountMenu(options);
    expect(menuItemLabels(menu)).toContain(label);
    if ("selectionCount" in options) {
      expect(menuItemLabels(menu)).not.toContain("Advanced");
      expect(menuItemLabels(menu)).not.toContain("Pin session");
    }
  });

  it.each([
    { pluginActions: [{ id: "review/open", label: "Open review", disabled: true }] },
    {
      pluginActions: [{ id: "review/open", label: "Open review" }],
      actionDisabledReasons: { plugin: "Admin access required" },
    },
    { pluginActions: [{ id: "review/open", label: "Open review" }], selectionCount: 2 },
    { pluginActions: [] },
  ])("blocks unavailable plugin actions: %j", async (options) => {
    const { menu, onAction } = await actionMenu({ ...options });
    const action = queryButton(menu, 'button[value="plugin:review/open"]');
    if (options.selectionCount === 2 || options.pluginActions.length === 0) {
      expect(action).toBeNull();
    } else {
      expect(action?.disabled).toBe(true);
      action?.click();
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    [
      { archiveAllowed: false, session: { archived: true } },
      [
        ["Restore session", false],
        ["Delete…", false],
        ["Pin session", true],
      ],
    ],
    [
      { archiveAllowed: true, deleteAllowed: false },
      [
        ["Archive session", false],
        ["Delete…", true],
      ],
    ],
    [
      { selectionCount: 2, archiveAllowed: false, deleteAllowed: false },
      [
        ["Archive 2", false],
        ["Delete 2…", true],
      ],
    ],
  ] as const)("gates archive, delete and pin: %j", async (options, disabled) => {
    const menu = await mountMenu(options);
    for (const [label, expected] of disabled) {
      expect(menuItem(menu, label).disabled).toBe(expected);
    }
  });

  it.each([
    ["Pin session", "з", "KeyP", "P", "toggle-pin"],
    ["Copy link", "c", undefined, "C", "copy-session-link"],
  ] as const)("dispatches the advertised %s shortcut", async (label, key, code, hint, kind) => {
    const { menu, onAction, onClose } = await actionMenu();
    const item = menuItem(menu, label);
    expect(item.getAttribute("aria-keyshortcuts")).toBe(hint);
    item.focus();
    const keydown = press(item, key, code ? { code } : {});
    await settleSessionMenu(menu);
    expect(onAction).toHaveBeenCalledWith({ kind });
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onAction.mock.invocationCallOrder[0]!);
    if (kind !== "copy-session-link") {
      expect(keydown.defaultPrevented).toBe(true);
    }
  });

  it("gates unavailable copy and navigation actions at native controls", async () => {
    const { menu, onAction } = await actionMenu({
      session: { sessionId: null },
      navigationAllowed: false,
      copyMarkdownAllowed: false,
      splitAllowed: false,
    });

    expect(menuItemLabels(menu)).not.toContain("Open in");
    await openAdvanced(menu, "Copy details");
    for (const label of ["Session ID", "Conversation as Markdown"]) {
      const button = menuItem(menu, label);
      expect(button.disabled).toBe(true);
      button.click();
    }
    for (const kind of [
      "copy-session-link",
      "copy-session-preview-link",
      "open-new-tab",
      "open-new-window",
      "split-right",
      "split-below",
    ]) {
      expect(menu.querySelector(`button[value="${kind}"]`)).toBeNull();
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([false, true])("selects and clears a group (returns=%s)", async (returnsToGroups) => {
    const { menu, onAction } = await actionMenu({
      session: { category: "Research", categoryClearReturnsToGroups: returnsToGroups },
      groups: ["Research", "Projects"],
    });
    const pin = menuItem(menu, "Pin session");
    press(pin, "1");
    expect(onAction).not.toHaveBeenCalled();
    const submenu = await openSubmenu(menu, "Move to group");
    expect(
      menuItem(submenu, returnsToGroups ? "Move back to Groups" : "Remove from group"),
    ).toBeDefined();
    const research = menuItem(submenu, "Research");
    expect(research.getAttribute("aria-checked")).toBe("true");
    research.focus();
    expect(press(research, "٢", { code: "Digit2" }).defaultPrevented).toBe(true);
    await settleSessionMenu(menu);
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });
    for (const [value, action] of [
      ["move-to-group:", { kind: "move-to-group", category: null }],
      ["new-group", { kind: "new-group" }],
    ] as const) {
      await reopen(menu);
      await openSubmenu(menu, "Move to group");
      await selectMenuValue(menu, value);
      expect(onAction).toHaveBeenCalledWith(action);
    }
  });

  it.each([
    { selectionCount: 2 },
    { actionDisabledReasons: { "set-color": "Write access required" } },
  ])("blocks disabled colors: %j", async (options) => {
    const { menu, onAction } = await actionMenu({ ...options });
    if (options.selectionCount === 2) {
      expect(menu.querySelector(".session-menu__appearance")).toBeNull();
    } else {
      await openAdvanced(menu, "Icon & color");
      for (const label of ["Red", "No color"]) {
        const choice = menu.querySelector<HTMLButtonElement>(
          `.session-menu__color-choice[aria-label="${label}"]`,
        );
        expect(choice?.disabled).toBe(true);
        choice?.click();
      }
      const reset = queryButton(menu, ".session-menu__icon-remove");
      expect(reset?.disabled).toBe(true);
      reset?.click();
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    "🧜‍♀️",
    '<svg\nxmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n<circle r="10"/>\n</svg>',
  ])("validates and applies custom icons with Enter: %s", async (value) => {
    const { menu, onAction, onClose } = await actionMenu();
    const submenu = await openAdvanced(menu, "Icon & color");
    queryButton(submenu, '[aria-label="Custom icon…"]')?.click();
    await settleSessionMenu(menu);
    const input = submenu.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input")!;
    await waitForSolid(() => expect(document.activeElement).toBe(input));
    for (const draft of ["", "a", value]) {
      input.value = draft;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await settleSessionMenu(menu);
      expect(queryButton(submenu, ".session-menu__icon-set")?.disabled).toBe(draft !== value);
    }
    for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
      expect(press(input, "Enter", composition).defaultPrevented).toBe(false);
      expect(onAction).not.toHaveBeenCalled();
    }
    press(input, "Enter");
    const icon = value.startsWith("<svg")
      ? `data:image/svg+xml,${encodeURIComponent(value)}`
      : value;
    expect(onAction).toHaveBeenCalledExactlyOnceWith({ kind: "set-icon", icon });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    queryButton(submenu, ".session-menu__icon-back")!.click();
    await settleSessionMenu(menu);
    const custom = queryButton(submenu, '[aria-label="Custom icon…"]')!;
    expect(document.activeElement).toBe(custom);
    expect(iconChoices(submenu).filter((choice) => choice.tabIndex === 0)).toEqual([custom]);
    expect(input.value).toBe("");
  });

  it("moves icon-grid focus by cell and visible row", async () => {
    const columns = 6;
    const menu = await mountMenu({ session: { icon: "🚀" } });
    const submenu = await openAdvanced(menu, "Icon & color");
    const choices = iconChoices(submenu);
    for (const [index, choice] of choices.entries()) {
      vi.spyOn(choice, "getBoundingClientRect").mockReturnValue(
        new DOMRect((index % columns) * 28, Math.floor(index / columns) * 28, 28, 28),
      );
    }
    choices[1]?.focus();

    press(choices[1]!, "ArrowLeft");
    expect(document.activeElement).toBe(choices[0]);
    press(choices[0]!, "ArrowRight");
    expect(document.activeElement).toBe(choices[1]);
    press(choices[1]!, "ArrowRight");
    expect(document.activeElement).toBe(choices[2]);
    press(choices[2]!, "ArrowDown");
    expect(document.activeElement).toBe(choices[2 + columns]);
    expect(choices.filter((choice) => choice.tabIndex === 0)).toEqual([choices[2 + columns]]);
    press(choices[2 + columns]!, "ArrowUp");
    expect(document.activeElement).toBe(choices[2]);
  });

  it.each([
    ["absent", null],
    [
      "PR",
      {
        pullRequestUrl: "https://github.com/openclaw/openclaw/pull/12345",
        worktreePath: null,
      },
    ],
    ["editor", { pullRequestUrl: null, worktreePath: "/work/trees/demo" }],
  ] as const)("opens resolved workspace destinations: %s", async (_name, work) => {
    const { menu, onAction } = await actionMenu({ work });
    const openIn = menuItem(menu, "Open in");
    expect(menuItemLabels(openIn)).toContain(work?.worktreePath ? "VS Code" : "New tab");
    if (work?.pullRequestUrl) {
      const openPr = menuItem(menu, "Open PR");
      openPr.focus();
      press(openPr, "g");
      await settleSessionMenu(menu);
      expect(onAction.mock.calls).toEqual([[{ kind: "open-pr", url: work.pullRequestUrl }]]);
    } else {
      expect(menuItemLabels(menu)).not.toContain("Open PR");
    }
    if (work?.worktreePath) {
      await openAdvanced(menu, "Open in");
      await selectMenuValue(menu, "open-in:vscode");
      expect(onAction).toHaveBeenCalledWith({
        kind: "open-in",
        editor: "vscode",
        path: work.worktreePath,
      });
    }
  });

  it("ignores shortcut keys for disabled items and modified keystrokes", async () => {
    const { menu, onAction } = await actionMenu({ archiveAllowed: false, deleteAllowed: false });

    const pin = menuItem(menu, "Pin session");
    pin.focus();
    press(pin, "d");
    press(pin, "p", { metaKey: true });
    press(pin, "x");

    expect(onAction).not.toHaveBeenCalled();
  });

  it("closes the session menu before its mobile navigation drawer on Escape", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const shell = createShellOwner();
    document.body.append(shell.element);
    shell.connect();
    shell.navDrawerOpen = true;
    const trigger = focusButton();
    try {
      const menu = await mountMenu({ trigger });
      const panel = menuPanel(menu);
      const item = menuItem(menu, "Pin session");
      item.focus();

      expect(press(item, "Escape").defaultPrevented).toBe(true);
      expect(panel.matches(":popover-open")).toBe(false);
      expect(document.activeElement).toBe(trigger);
      expect(shell.navDrawerOpen).toBe(true);

      expect(press(trigger, "Escape").defaultPrevented).toBe(true);
      expect(shell.navDrawerOpen).toBe(false);
    } finally {
      shell.disconnect();
      shell.element.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe("sidebar snooze menu", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps custom snooze usable after compact Back and reentry", async () => {
    const { menu, onAction } = await actionMenu({ compact: true, snoozeAllowed: true });
    await selectMenuValue(menu, "compact:open-snooze");
    await selectMenuValue(menu, "compact:back");
    await selectMenuValue(menu, "compact:open-snooze");
    await selectMenuValue(menu, "snooze-custom");
    const input = menu.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    await waitForSolid(() => expect(document.activeElement).toBe(input));
    input.value = "2099-01-01T09:00";
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onAction).toHaveBeenCalledWith({
      kind: "snooze",
      snoozedUntil: new Date(2099, 0, 1, 9).getTime(),
      rememberCustom: true,
    });
  });

  it.each([false, true])("selects snooze time (compact=%s)", async (compact) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2026, 8, 29, 9);
    vi.setSystemTime(now);
    const { menu, onAction } = await actionMenu({ snoozeAllowed: true, compact });
    if (compact) {
      await selectMenuValue(menu, "compact:open-snooze");
      await settleSessionMenu(menu);
    }
    const choices = compact ? menu : await openSubmenu(menu, "Snooze");
    expect(menuItemLabels(choices)).toContain("Choose another time");
    const value = menuItem(menu, "This evening · 6:00 PM").getAttribute("value")!;
    await selectMenuValue(menu, value);
    expect(onAction).toHaveBeenCalledWith({
      kind: "snooze",
      snoozedUntil: new Date(2026, 8, 29, 18).getTime(),
    });
    vi.setSystemTime(new Date(2026, 8, 29, 11));
    await reopen(menu);
    if (compact) {
      await selectMenuValue(menu, "compact:open-snooze");
    }
    const reopened = compact ? menu : await openSubmenu(menu, "Snooze");
    expect(menuItemLabels(reopened)).toContain("In 1 hour · 12:00 PM");
  });

  it("offers Wake session with the scheduled time and treats expired snoozes as awake", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2026, 8, 29, 9).getTime();
    vi.setSystemTime(now);
    const { menu, onAction } = await actionMenu({
      snoozeAllowed: true,
      session: { snoozedUntil: now + 3_600_000 },
    });
    expect(menuItemLabels(menu)).toContain("Wake session · 10:00 AM");
    expect(menuItemLabels(menu)).not.toContain("Snooze");
    await selectMenuValue(menu, "wake");
    expect(onAction).toHaveBeenCalledWith({ kind: "wake" });
    menu.session = { ...menu.session, snoozedUntil: now };
    await settleSessionMenu(menu);
    expect(menuItemLabels(menu)).toContain("Snooze");
    expect(menuItemLabels(menu).some((label) => label.startsWith("Wake session"))).toBe(false);
  });

  it.each([{ archived: true }, { isChild: true }, { pinnable: false }])(
    "omits ineligible snoozes: %j",
    async (session) => {
      const { menu, onAction } = await actionMenu({ snoozeAllowed: true, session });
      expect(menuItemLabels(menu)).not.toContain("Snooze");
      expect(menuItemLabels(menu).some((label) => label.startsWith("Wake session"))).toBe(false);
      expect(menu.querySelector('button[value^="snooze:"]')).toBeNull();
      expect(menu.querySelector('button[value="wake"]')).toBeNull();
      expect(onAction).not.toHaveBeenCalled();
    },
  );
});
