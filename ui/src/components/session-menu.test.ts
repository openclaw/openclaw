/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createShellOwner } from "../app/app-host-solid.test-support.ts";
import { i18n } from "../i18n/index.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import type { ApplicationContextProvider } from "../test-helpers/application-context.ts";
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

const copyLabels = ["Preview link", "Conversation as Markdown", "Session ID"];
const editorLabels = ["Cursor", "VS Code", "Windsurf", "Zed"];

async function actionMenu(options: Parameters<typeof mountMenu>[0] = {}) {
  const onAction = vi.fn<(action: SessionMenuAction) => void>();
  const onClose = vi.fn();
  return { menu: await mountMenu({ ...options, onAction, onClose }), onAction, onClose };
}
async function recordedMenu() {
  const calls: string[] = [];
  const menu = await mountMenu({
    onClose: () => calls.push("close"),
    onAction: (action) => calls.push(action.kind),
  });
  return { menu, calls };
}
async function openAppearance(menu: Awaited<ReturnType<typeof mountMenu>>, compact = false) {
  if (!compact) {
    return openAdvanced(menu, "Icon & color");
  }
  await selectMenuValue(menu, "compact:open-advanced");
  await settleSessionMenu(menu);
  await selectMenuValue(menu, "compact:open-icon");
  await settleSessionMenu(menu);
  return menu;
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
    expect(menuItemLabels(menu).filter((label) => label.startsWith("Assign to"))).toEqual([
      "Assign to…",
    ]);
    await waitForOwners(menu, ["Me", "Research", "Colleague", "zed@example.test"]);
    const selected = menuItem(menu, selectedLabel);
    await waitForSolid(() => expect(selected.getAttribute("role")).toBe("menuitemradio"));
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected).toMatchObject({ disabled: true });
    expect(selected.querySelector(".session-menu__check")).not.toBeNull();
    const other = menuItem(menu, otherLabel);
    expect(other.getAttribute("aria-checked")).toBe("false");
    expect(other.disabled).toBe(false);

    for (const [index, label] of ["Me", otherLabel].entries()) {
      if (index > 0) {
        await reopen(menu);
      }
      await openSubmenu(menu, "Assign to…");
      const value = menuItem(menu, label).getAttribute("value");
      expect(value).not.toBeNull();
      await selectMenuValue(menu, value!);
    }
    expect(onAction.mock.calls).toEqual([
      [{ kind: "assign-owner", owner: { type: "human", id: "profile-ada" } }],
      [{ kind: "assign-owner", owner: { type: otherType, id: "research:one" } }],
    ]);
    expect(onClose).toHaveBeenCalledTimes(2);
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
    expect(menuItemLabels(menuItem(menu, "Advanced"))).not.toContain("Assign to…");
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
    ["Archive session", {}, "toggle-archived", { kind: "toggle-archived" }],
    ["Archive session", { compact: true }, "toggle-archived", { kind: "toggle-archived" }],
    [
      "Stop cloud worker…",
      { cloudWorkerStopAllowed: true },
      "stop-cloud-worker",
      { kind: "stop-cloud-worker" },
    ],
    [
      "Open review",
      { pluginActions: [{ id: "review/open", label: "Open review" }] },
      "plugin:review/open",
      { kind: "plugin", id: "review/open" },
    ],
  ] as const)("dispatches root action %s", async (label, options, value, action) => {
    const { menu, onAction, onClose } = await actionMenu(options);
    expect(menuItemLabels(menu)).toContain(label);
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

  it("drills into compact menu groups without rendering side flyouts", async () => {
    const { context } = createSessionOwnerMenuHarness(undefined, "Research owner");
    const menu = await mountMenu({
      compact: true,
      groups: ["Research", "Operations"],
      context,
      currentOwner: { type: "agent", id: "research:one" },
      work: {
        loading: false,
        pullRequestUrl: "https://example.test/pr",
        worktreePath: "/work/openclaw",
      },
    });

    expect(menuPanel(menu).querySelector('[role="menu"]')).toBeNull();
    expect(menuItemLabels(menu)).not.toContain("Open in");
    expect(menuItemLabels(menu)).toContain("Advanced");
    expect(menuItemLabels(menu)).toContain("Assign to…");
    expect(menuItemLabels(menu)).not.toContain("Icon & color");
    expect(menuItemLabels(menu)).toContain("Move to group");

    for (const [view, labels] of [
      ["open-in", ["Back", "New tab", "New window", ...editorLabels]],
      ["copy", ["Back", ...copyLabels]],
      ["assign-owner", ["Back", "Me", "Research owner"]],
      ["icon", ["Back"]],
      ["group", ["Back", "Research", "Operations", "New group"]],
    ] as const) {
      if (["open-in", "copy", "icon"].includes(view)) {
        await selectMenuValue(menu, "compact:open-advanced");
        await settleSessionMenu(menu);
      }
      await selectMenuValue(menu, `compact:open-${view}`);
      await settleSessionMenu(menu);
      expectLabels(menu, labels);
      expect(menuPanel(menu).querySelector('[role="menu"]')).toBeNull();
      if (view === "icon") {
        expect(menu.querySelectorAll(".session-menu__color-choice")).toHaveLength(9);
      }
      await selectMenuValue(
        menu,
        ["open-in", "copy", "icon"].includes(view) ? "compact:back-advanced" : "compact:back",
      );
      await settleSessionMenu(menu);
      if (["open-in", "copy", "icon"].includes(view)) {
        await selectMenuValue(menu, "compact:back");
        await settleSessionMenu(menu);
      }
    }
  });

  it("describes the active session and its stable fork boundary", async () => {
    const menu = await mountMenu({ forkFromLastCompleted: true });
    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
    expect(menuItem(menu, "Fork conversation").getAttribute("title")).toBe(
      "Fork from last completed message",
    );
  });

  it.each([
    [
      "child",
      { session: { isChild: true } },
      [
        "Rename…",
        "Mark as unread",
        "Copy link",
        "Move to group",
        "Move to top level",
        "Archive session",
        "Advanced",
      ],
    ],
    [
      "batch",
      {
        selectionCount: 3,
        cloudWorkerStopAllowed: true,
        work: { loading: false, pullRequestUrl: "https://example.test/pr", worktreePath: "/tmp/x" },
      },
      ["Mark 3 as unread", "Archive 3", "Move 3 to group", "Delete 3…"],
    ],
    [
      "unread batch",
      { selectionCount: 2, session: { unread: true } },
      ["Mark 2 as read", "Archive 2", "Move 2 to group", "Delete 2…"],
    ],
    [
      "archived batch",
      { selectionCount: 2, session: { archived: true } },
      ["Mark 2 as unread", "Restore 2", "Move 2 to group", "Delete 2…"],
    ],
  ] as const)("renders only applicable actions for a %s", async (_name, options, labels) => {
    const menu = await mountMenu(options);
    expectLabels(menu, labels);
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
    {
      options: { archiveAllowed: false, session: { archived: true } },
      disabled: [
        ["Restore session", false],
        ["Delete…", false],
        ["Pin session", true],
      ],
    },
    {
      options: { archiveAllowed: true, deleteAllowed: false },
      disabled: [
        ["Archive session", false],
        ["Delete…", true],
      ],
    },
    {
      options: { selectionCount: 2, archiveAllowed: false, deleteAllowed: false },
      disabled: [
        ["Archive 2", false],
        ["Delete 2…", true],
      ],
    },
  ] as const)("gates archive, delete and pin: $options", async ({ options, disabled }) => {
    const menu = await mountMenu(options);
    for (const [label, expected] of disabled) {
      expect(menuItem(menu, label).disabled).toBe(expected);
    }
  });

  it.each([
    ["Pin session", "з", "KeyP", "P", "toggle-pin"],
    ["Copy link", "c", undefined, "C", "copy-session-link"],
  ] as const)("dispatches the advertised %s shortcut", async (label, key, code, hint, kind) => {
    const { calls, menu } = await recordedMenu();
    const item = menuItem(menu, label);
    expect(item.getAttribute("aria-keyshortcuts")).toBe(hint);
    expect(menuItem(menu, "Move to group").dataset.shortcut).toBeUndefined();
    if (kind === "copy-session-link") {
      expect(menu.querySelectorAll('[value="copy-session-link"]')).toHaveLength(1);
      expectLabels(menuItem(menu, "Copy details"), copyLabels);
    } else {
      expect(item.querySelector(".session-menu__shortcut")?.textContent).toBe(hint);
    }
    item.focus();
    const keydown = press(item, key, code ? { code } : {});
    await settleSessionMenu(menu);
    expect(calls).toEqual(["close", kind]);
    if (kind === "copy-session-link") {
      calls.length = 0;
      await reopen(menu);
      await openAdvanced(menu, "Copy details");
      await selectMenuValue(menu, "copy-session-id");
      expect(calls).toEqual(["close", "copy-session-id"]);
    } else {
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

    expect(menuItem(menu, "Session ID").disabled).toBe(true);
    expect(menuItem(menu, "Conversation as Markdown").disabled).toBe(true);
    expectLabels(menuItem(menu, "Copy details"), ["Conversation as Markdown", "Session ID"]);
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

  it.each([
    { returnsToGroups: false, removeLabel: "Remove from group" },
    { returnsToGroups: true, removeLabel: "Move back to Groups" },
  ])("selects groups (returns=$returnsToGroups)", async ({ returnsToGroups, removeLabel }) => {
    const { menu, onAction } = await actionMenu({
      session: { category: "Research", categoryClearReturnsToGroups: returnsToGroups },
      groups: ["Research", "Projects"],
    });
    const pin = menuItem(menu, "Pin session");
    pin.focus();
    press(pin, "1");
    expect(onAction).not.toHaveBeenCalled();
    const submenu = await openSubmenu(menu, "Move to group");
    expectLabels(submenu, ["Research", "Projects", removeLabel, "New group"]);
    expect(
      Array.from(
        submenu.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]'),
        (item) => item.dataset.shortcut,
      ),
    ).toEqual(["1", "2", "3", "4"]);
    expect(
      menuItem(submenu, "Projects").querySelector(".session-menu__shortcut")?.textContent,
    ).toBe("2");
    const research = menuItem(submenu, "Research");
    const remove = menuItem(submenu, removeLabel);
    const create = menuItem(submenu, "New group");
    await settleSessionMenu(menu);
    expect(research.getAttribute("role")).toBe("menuitemradio");
    expect(research.getAttribute("aria-checked")).toBe("true");
    expect(remove.getAttribute("role")).toBe("menuitem");
    expect(create.getAttribute("role")).toBe("menuitem");

    research.focus();
    const keydown = press(research, "٢", { code: "Digit2" });
    await settleSessionMenu(menu);
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });
    expect(keydown.defaultPrevented).toBe(true);
    onAction.mockClear();
    await reopen(menu);
    await openSubmenu(menu, "Move to group");
    await selectMenuValue(menu, "move-to-group:Projects");
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });

    await reopen(menu);
    await openSubmenu(menu, "Move to group");
    await selectMenuValue(menu, "move-to-group:");
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: null });

    await reopen(menu);
    await openSubmenu(menu, "Move to group");
    await selectMenuValue(menu, "new-group");
    expect(onAction).toHaveBeenCalledWith({ kind: "new-group" });
  });

  it.each([false, true])("edits appearance (compact=%s)", async (compact) => {
    const { menu, onAction, onClose } = await actionMenu({
      compact,
      session: { icon: "🦞", color: "blue" },
    });
    await openAppearance(menu, compact);
    if (compact) {
      await selectMenuValue(menu, "compact:back-advanced");
      await selectMenuValue(menu, "compact:open-icon");
    }
    const blue = queryButton(menu, '.session-menu__color-choice[aria-label="Blue"]');
    expect(blue?.getAttribute("aria-pressed")).toBe("true");
    expect(menu.querySelectorAll('.session-menu__colors [aria-pressed="true"]')).toHaveLength(1);
    const choices = iconChoices(menu);
    expect(choices[0]?.getAttribute("role")).toBeNull();
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(choices.filter((choice) => choice.tabIndex === 0)).toEqual([choices[0]]);
    queryButton(menu, '.session-menu__color-choice[aria-label="Purple"]')?.click();
    iconChoices(menu)[1]?.click();
    const noIcon = queryButton(menu, '[aria-label="No icon"]');
    expect(noIcon).not.toBeNull();
    noIcon?.click();
    queryButton(menu, '.session-menu__color-choice[aria-label="No color"]')?.click();
    const reset = queryButton(menu, ".session-menu__icon-remove");
    expect(reset?.previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(reset?.textContent?.trim()).toBe("Reset to default");
    reset?.click();
    expect(onAction.mock.calls).toEqual([
      [{ kind: "set-color", color: "purple" }],
      [{ kind: "set-icon", icon: "🚀" }],
      [{ kind: "set-icon", icon: null }],
      [{ kind: "set-color", color: null }],
      [{ kind: "reset-appearance" }],
    ]);
    expect(onClose).not.toHaveBeenCalled();
    menu.session = { ...menu.session, icon: "🚀", color: "purple" };
    await settleSessionMenu(menu);
    expect(
      menu.querySelector('.session-menu__icon-choice[aria-pressed="true"]')?.textContent?.trim(),
    ).toBe("🚀");
    expect(
      menu
        .querySelector('.session-menu__color-choice[aria-pressed="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Purple");
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
    { name: "emoji", value: "🧜‍♀️", icon: "🧜‍♀️" },
    {
      name: "multiline SVG",
      value:
        '<svg\nxmlns="http://www.w3.org/2000/svg"\nviewBox="0 0 24 24">\n<circle cx="12" cy="12" r="10"/>\n</svg>',
      icon: `data:image/svg+xml,${encodeURIComponent('<svg\nxmlns="http://www.w3.org/2000/svg"\nviewBox="0 0 24 24">\n<circle cx="12" cy="12" r="10"/>\n</svg>')}`,
    },
  ])("validates and applies custom $name with Enter", async ({ value, icon }) => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) =>
        calls.push(`${action.kind}:${action.kind === "set-icon" ? action.icon : ""}`),
    });
    const submenu = await openAppearance(menu);
    queryButton(submenu, '[aria-label="Custom icon…"]')?.click();
    await settleSessionMenu(menu);

    const input = submenu.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input");
    const set = queryButton(submenu, ".session-menu__icon-set");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-label")).toBe("Custom icon");
    await waitForSolid(() => expect(document.activeElement).toBe(input));
    expect(set?.disabled).toBe(true);

    if (!input) {
      throw new Error("Expected custom emoji input");
    }
    input.value = "a";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settleSessionMenu(menu);
    expect(queryButton(submenu, ".session-menu__icon-set")?.disabled).toBe(true);

    input.value = value;
    expect(input.value).toBe(value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settleSessionMenu(menu);
    expect(queryButton(submenu, ".session-menu__icon-set")?.disabled).toBe(false);
    for (const composition of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
      const event = press(input, "Enter", composition);
      expect(calls).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    }
    press(input, "Enter");

    expect(calls).toEqual([`set-icon:${icon}`]);
    expect(document.activeElement).toBe(input);
  });

  it("returns from custom entry on Escape without closing the menu", async () => {
    const onClose = vi.fn();
    const menu = await mountMenu({ onClose, session: { icon: "braces" } });
    const submenu = await openAppearance(menu);
    const braces = queryButton(submenu, '[aria-label="braces"]');
    expect(braces?.getAttribute("aria-pressed")).toBe("true");
    expect(braces?.tabIndex).toBe(0);
    queryButton(submenu, '[aria-label="Custom icon…"]')?.click();
    await settleSessionMenu(menu);
    const input = submenu.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input");
    if (!input) {
      throw new Error("Expected custom emoji input");
    }

    press(input, "Escape");
    await settleSessionMenu(menu);

    const customEntry = input.closest(".session-menu__icon-custom-entry");
    expect(customEntry?.getAttribute("aria-hidden")).toBe("true");
    expect(customEntry?.hasAttribute("inert")).toBe(true);
    expect(submenu.querySelector(".session-menu__icon-options")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(submenu.querySelector('[aria-label="Custom icon…"]'));
    const currentIcon = queryButton(submenu, '.session-menu__icon-options button[tabindex="0"]');
    const reset = queryButton(submenu, ".session-menu__icon-remove");
    if (!currentIcon || !reset) {
      throw new Error("Expected the current icon and reset control");
    }
    // jsdom has no layout; inert controls are still filtered by the menu owner.
    for (const control of submenu.querySelectorAll<HTMLElement>("[data-form-control]")) {
      control.checkVisibility = () => true;
    }
    currentIcon.focus();
    press(currentIcon, "Tab");
    expect(document.activeElement).toBe(reset);
    press(reset, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(currentIcon);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves icon-grid focus by cell and visible row", async () => {
    const columns = 6;
    const menu = await mountMenu({ session: { icon: "🚀" } });
    const submenu = await openAppearance(menu);
    const choices = iconChoices(submenu);
    for (const [index, choice] of choices.entries()) {
      vi.spyOn(choice, "getBoundingClientRect").mockReturnValue(
        new DOMRect((index % columns) * 28, Math.floor(index / columns) * 28, 28, 28),
      );
    }
    choices[1]?.focus();

    press(choices[1]!, "ArrowRight");
    expect(document.activeElement).toBe(choices[2]);
    press(choices[2]!, "ArrowDown");
    expect(document.activeElement).toBe(choices[2 + columns]);
    expect(choices.filter((choice) => choice.tabIndex === 0)).toEqual([choices[2 + columns]]);
    press(choices[2 + columns]!, "ArrowUp");
    expect(document.activeElement).toBe(choices[2]);
  });

  it.each([{ groups: [] }, { groups: ["Research"] }])(
    "opens unassigned groups: $groups",
    async ({ groups }) => {
      const menu = await mountMenu({ groups });
      const trigger = menuItem(menu, "Move to group");
      const submenu = await openSubmenu(menu, "Move to group");
      expectLabels(submenu, [...groups, "New group"]);
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(submenu.getAttribute("role")).toBe("menu");
      expect(submenu.matches(":popover-open")).toBe(true);
    },
  );

  it.each([
    ["absent", null],
    ["unresolved", { loading: true, pullRequestUrl: null, worktreePath: null }],
    [
      "PR",
      {
        loading: false,
        pullRequestUrl: "https://github.com/openclaw/openclaw/pull/12345",
        worktreePath: null,
      },
    ],
    ["editor", { loading: false, pullRequestUrl: null, worktreePath: "/work/trees/demo" }],
  ] as const)("opens resolved workspace destinations: %s", async (_name, work) => {
    const { menu, onAction } = await actionMenu({ work });
    const openIn = menuItem(menu, "Open in");
    expectLabels(openIn, ["New tab", "New window", ...(work?.worktreePath ? editorLabels : [])]);
    if (work?.pullRequestUrl) {
      const openPr = menuItem(menu, "Open PR");
      expect(openPr.disabled).toBe(false);
      expect(openPr.hasAttribute("data-new-tab-action")).toBe(true);
      expect(openPr.querySelector(".session-menu__shortcut")?.textContent).toBe("G");
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

  it.each([false, true])("restores Tab focus (outside=%s)", async (outside) => {
    const trigger = focusButton();
    const menu = await mountMenu({ trigger });
    const item = outside ? focusButton() : menuItem(menu, "Pin session");
    item.focus();
    const keydown = press(item, "Tab");
    expect(document.activeElement).toBe(outside ? item : trigger);
    expect(keydown.defaultPrevented).toBe(false);
  });

  it.each(["Escape", "native hide"])("closes with focus ownership on %s", async (event) => {
    const trigger = focusButton();
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });
    const panel = menuPanel(menu);
    const item = menuItem(menu, "Pin session");
    item.focus();
    const escaped = vi.fn();
    window.addEventListener("keydown", escaped);
    onTestFinished(() => window.removeEventListener("keydown", escaped));
    if (event === "Escape") {
      expect(press(item, event).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(trigger);
      expect(onClose).toHaveBeenCalledTimes(1);
    } else {
      panel.hidePopover();
      await settleSessionMenu(menu);
      expect(document.activeElement).not.toBe(trigger);
    }
    expect(escaped).not.toHaveBeenCalled();
    await waitForSolid(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(panel.matches(":popover-open")).toBe(false);
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
    const labels = menuItemLabels(choices);
    expect(labels.at(-1)).toBe("Choose another time");
    expect(labels.filter((label) => label.includes(" · "))).toEqual([
      "In 1 hour · 10:00 AM",
      "In 3 hours · 12:00 PM",
      "This evening · 6:00 PM",
      "Tomorrow · 9:00 AM",
      "Next week · Mon 9:00 AM",
    ]);
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
