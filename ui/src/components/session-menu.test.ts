/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  containers,
  mountMenu,
  menuItemLabels,
  menuItem,
  iconChoices,
  selectMenuValue,
  type SessionMenuItem,
} from "../test-helpers/session-menu.ts";
import {
  createSessionOwnerMenuHarness,
  sessionOwnerProfiles,
} from "../test-helpers/session-owner-menu.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { SessionMenuAction } from "./session-menu.ts";

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

describe("session menu", () => {
  it("keeps self, agents, and the current owner while the directory loads, then retries a visible failure", async () => {
    const pending = deferred<ReturnType<typeof sessionOwnerProfiles>>();
    const { context, request } = createSessionOwnerMenuHarness(() => pending.promise);
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
      const selected = menu.querySelector<SessionMenuItem>('wa-dropdown-item[aria-checked="true"]');
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
    selectMenuValue(menu, "reload-owners");
    await waitForFast(() =>
      expect(menuItemLabels(menuItem(menu, "Assign to…"))).toEqual([
        "Me",
        "Research",
        "Bob",
        "Carol",
      ]),
    );
    expect(menu.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["reconnect", "replace gateway"] as const)(
    "retires an in-flight directory on %s",
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
      await waitForFast(() =>
        expect(menuItemLabels(menuItem(menu, "Assign to…"))).toEqual(["Me", "Research", "Carol"]),
      );
      pending.resolve(sessionOwnerProfiles("Bob"));
      await pending.promise;
      await menu.updateComplete;
      expect(menuItemLabels(menuItem(menu, "Assign to…"))).toEqual(["Me", "Research", "Carol"]);
    },
  );

  it.each([
    {
      name: "agent",
      currentOwner: { type: "agent", id: "research:one" },
      selectedLabel: "Research",
      otherLabel: "Colleague",
      otherType: "human",
    },
    {
      name: "merged profile",
      currentOwner: {
        type: "human",
        id: "profile-merged-colleague",
        identity: { type: "profile", id: "research:one" },
      },
      selectedLabel: "Colleague",
      otherLabel: "Research",
      otherType: "agent",
    },
  ] as const)(
    "selects the canonical $name while distinguishing people and naming blank profiles",
    async ({ currentOwner, selectedLabel, otherLabel, otherType }) => {
      const onAction = vi.fn<(action: SessionMenuAction) => void>();
      const onClose = vi.fn();
      const profiles = sessionOwnerProfiles("Colleague", "Zed", "Merged colleague").profiles.map(
        (profile, index) =>
          Object.assign(
            profile,
            index === 0
              ? { id: "research:one" }
              : index === 1
                ? { displayName: "  ", emails: ["zed@example.test"] }
                : { mergedInto: "research:one" },
          ),
      );
      const { context } = createSessionOwnerMenuHarness(() => ({ profiles }));
      const menu = await mountMenu({
        context,
        currentOwner,
        onAction,
        onClose,
      });
      const submenu = menuItem(menu, "Assign to…");
      expect(menuItemLabels(menu).filter((label) => label.startsWith("Assign to"))).toEqual([
        "Assign to…",
      ]);
      await waitForFast(() =>
        expect(menuItemLabels(submenu)).toEqual([
          "Me",
          "Research",
          "Colleague",
          "zed@example.test",
        ]),
      );
      const selected = menuItem(menu, selectedLabel);
      await waitForSolid(() => expect(selected.getAttribute("role")).toBe("menuitemradio"));
      expect(selected.getAttribute("aria-checked")).toBe("true");
      expect(selected.disabled).toBe(true);
      expect(selected.querySelector("[slot='details']")).not.toBeNull();
      const other = menuItem(menu, otherLabel);
      expect(other.getAttribute("aria-checked")).toBe("false");
      expect(other.disabled).toBe(false);

      for (const label of ["Me", otherLabel]) {
        const value = menuItem(menu, label).getAttribute("value");
        if (!value) {
          throw new Error("Expected owner action");
        }
        selectMenuValue(menu, value);
      }
      expect(onAction.mock.calls).toEqual([
        [{ kind: "assign-owner", owner: { type: "human", id: "profile-ada" } }],
        [{ kind: "assign-owner", owner: { type: otherType, id: "research:one" } }],
      ]);
      expect(onClose).toHaveBeenCalledTimes(2);
      const closeOrder = onClose.mock.invocationCallOrder[0];
      const actionOrder = onAction.mock.invocationCallOrder[0];
      if (closeOrder === undefined || actionOrder === undefined) {
        throw new Error("Expected close and action call order");
      }
      expect(closeOrder).toBeLessThan(actionOrder);

      const batch = await mountMenu({
        selectionCount: 2,
        context,
      });
      expect(batch.textContent).not.toContain("Assign to");
    },
  );

  it.each([
    { name: "self only", names: ["Ada"], agents: [], expected: false },
    { name: "two offline people", names: ["Ada", "Bob"], agents: [], expected: true },
    {
      name: "one human and an agent",
      names: ["Ada"],
      agents: [{ id: "research:one" }],
      expected: true,
    },
    {
      name: "duplicate and merged profiles",
      names: ["Ada", "Ada", "Merged"],
      agents: [],
      expected: false,
    },
    {
      name: "typed identity collision",
      names: ["Ada"],
      agents: [{ id: "profile-ada" }],
      expected: true,
    },
  ])(
    "shows root assignment for eligible directory identities: $name",
    async ({ names, agents, expected }) => {
      const profiles = sessionOwnerProfiles(...names);
      for (const profile of profiles.profiles) {
        if (profile.displayName === "Merged") {
          profile.mergedInto = "profile-ada";
        }
      }
      const owner = createSessionOwnerMenuHarness(() => profiles);
      owner.context.agents.state.agentsList!.agents = agents;
      const menu = await mountMenu({ context: owner.context });
      await waitForFast(() => expect(owner.request).toHaveBeenCalledWith("users.list", {}));
      await waitForFast(() => expect(menu.textContent).not.toContain("Loading"));
      expect(menuItemLabels(menu).includes("Assign to…")).toBe(expected);
      expect(menuItemLabels(menuItem(menu, "Advanced"))).not.toContain("Assign to…");
    },
  );

  it("keeps known assignees while refreshing and coalesces repeated opens", async () => {
    const owner = createSessionOwnerMenuHarness(() => sessionOwnerProfiles("Ada", "Bob"));
    owner.context.agents.state.agentsList!.agents = [];
    const menu = await mountMenu({ context: owner.context });
    await waitForFast(() => expect(menuItemLabels(menu)).toContain("Assign to…"));
    const pending = deferred<ReturnType<typeof sessionOwnerProfiles>>();
    owner.request.mockImplementation(() => pending.promise);
    const open = () => menu.querySelector("wa-dropdown")!.dispatchEvent(new Event("wa-show"));
    open();
    open();
    await menu.updateComplete;
    expect(owner.request).toHaveBeenCalledTimes(2);
    expect(menuItemLabels(menu)).toContain("Assign to…");
    pending.resolve(sessionOwnerProfiles("Ada"));
    await waitForFast(() => expect(menuItemLabels(menu)).not.toContain("Assign to…"));
  });

  it.each([false, true])(
    "keeps archive choices in one root entry (compact=%s)",
    async (compact) => {
      const onAction = vi.fn();
      const menu = await mountMenu({ compact, session: { hasChildren: true }, onAction });
      expect(menuItemLabels(menu)).toContain("Archive session");
      expect(menuItemLabels(menu)).not.toContain("Archive session and children…");
      if (compact) {
        selectMenuValue(menu, "compact:open-archive");
        await menu.updateComplete;
        expect(menuItem(menu, "Back").getAttribute("value")).toBe("compact:back");
      }
      const choices = compact ? menu : menuItem(menu, "Archive session");
      expect(menuItemLabels(choices)).toEqual([
        ...(compact ? ["Back"] : []),
        "Session only",
        "Archive session and children…",
      ]);
      selectMenuValue(menu, "archive-tree");
      expect(onAction).toHaveBeenCalledWith({ kind: "archive-tree" });
    },
  );

  it("disables only denied mutation actions and ignores forced selection", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      onAction,
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
    selectMenuValue(menu, "delete");
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

    expect(menu.querySelector("[slot='submenu']")).toBeNull();
    expect(menuItemLabels(menu)).not.toContain("Open in");
    expect(menuItemLabels(menu)).toContain("Advanced");
    expect(menuItemLabels(menu)).toContain("Assign to…");
    expect(menuItemLabels(menu)).not.toContain("Icon & color");
    expect(menuItemLabels(menu)).toContain("Move to group");

    for (const [view, labels] of [
      ["open-in", ["Back", "New tab", "New window", "Cursor", "VS Code", "Windsurf", "Zed"]],
      ["copy", ["Back", "Preview link", "Conversation as Markdown", "Session ID"]],
      ["assign-owner", ["Back", "Me", "Research owner"]],
      ["icon", ["Back"]],
      ["group", ["Back", "Research", "Operations", "New group"]],
    ] as const) {
      selectMenuValue(menu, `compact:open-${view}`);
      await menu.updateComplete;
      expect(menuItemLabels(menu)).toEqual(labels);
      expect(menu.querySelector("[slot='submenu']")).toBeNull();
      if (view === "icon") {
        expect(menu.querySelectorAll(".session-menu__color-choice")).toHaveLength(9);
        expect(menu.querySelector(".session-menu__icon-picker")?.getAttribute("slot")).toBeNull();
      }
      selectMenuValue(menu, "compact:back");
      await menu.updateComplete;
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
    {
      name: "child",
      options: { session: { isChild: true } },
      labels: [
        "Rename…",
        "Mark as unread",
        "Copy link",
        "Move to group",
        "Move to top level",
        "Archive session",
        "Advanced",
      ],
    },
    {
      name: "batch",
      options: {
        selectionCount: 3,
        cloudWorkerStopAllowed: true,
        work: { loading: false, pullRequestUrl: "https://example.test/pr", worktreePath: "/tmp/x" },
      },
      labels: ["Mark 3 as unread", "Archive 3", "Move 3 to group", "Delete 3…"],
    },
    {
      name: "unread batch",
      options: { selectionCount: 2, session: { unread: true } },
      labels: ["Mark 2 as read", "Archive 2", "Move 2 to group", "Delete 2…"],
    },
    {
      name: "archived batch",
      options: { selectionCount: 2, session: { archived: true } },
      labels: ["Mark 2 as unread", "Restore 2", "Move 2 to group", "Delete 2…"],
    },
  ])("renders only applicable actions for a $name", async ({ options, labels }) => {
    const menu = await mountMenu(options);
    expect(menuItemLabels(menu)).toEqual(labels);
  });

  it("offers an explicit cloud worker stop action for a stoppable placement", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ cloudWorkerStopAllowed: true, onAction });

    menuItem(menu, "Stop cloud worker…").click();

    expect(onAction).toHaveBeenCalledWith({ kind: "stop-cloud-worker" });
  });

  it("dispatches a namespaced plugin action after closing the menu", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const onClose = vi.fn();
    const menu = await mountMenu({
      pluginActions: [{ id: "review/open", label: "Open review" }],
      onAction,
      onClose,
    });
    menuItem(menu, "Open review").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "plugin", id: "review/open" });
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onAction.mock.invocationCallOrder[0]!);
  });

  it.each([
    { pluginActions: [{ id: "review/open", label: "Open review", disabled: true }] },
    {
      pluginActions: [{ id: "review/open", label: "Open review" }],
      actionDisabledReasons: { plugin: "Admin access required" },
    },
    { pluginActions: [{ id: "review/open", label: "Open review" }], selectionCount: 2 },
    { pluginActions: [] },
  ])("does not dispatch an unavailable plugin action: %j", async (options) => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ ...options, onAction });
    selectMenuValue(menu, "plugin:review/open");
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
  ] as const)(
    "guards archive, delete and pin independently: $options",
    async ({ options, disabled }) => {
      const menu = await mountMenu(options);
      for (const [label, expected] of disabled) {
        expect(menuItem(menu, label).disabled).toBe(expected);
      }
    },
  );

  it("copies the common link directly while keeping other formats in Advanced", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action.kind),
    });
    const link = menuItem(menu, "Copy link");
    expect(link.getAttribute("aria-keyshortcuts")).toBe("C");
    expect(menu.querySelectorAll('[value="copy-session-link"]')).toHaveLength(1);
    expect(menuItemLabels(menuItem(menu, "Copy details"))).toEqual([
      "Preview link",
      "Conversation as Markdown",
      "Session ID",
    ]);
    press(document, "c");
    expect(calls).toEqual(["close", "copy-session-link"]);
    calls.length = 0;
    menuItem(menu, "Session ID").click();
    expect(calls).toEqual(["close", "copy-session-id"]);
  });

  it("gates unavailable copy and navigation actions even on forced selection", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      session: { sessionId: null },
      navigationAllowed: false,
      copyMarkdownAllowed: false,
      splitAllowed: false,
      onAction,
    });

    expect(menuItem(menu, "Session ID").disabled).toBe(true);
    expect(menuItem(menu, "Conversation as Markdown").disabled).toBe(true);
    expect(menuItemLabels(menuItem(menu, "Copy details"))).toEqual([
      "Conversation as Markdown",
      "Session ID",
    ]);
    expect(menuItemLabels(menu)).not.toContain("Open in");
    for (const kind of [
      "copy-session-id",
      "copy-session-link",
      "copy-session-preview-link",
      "copy-markdown",
      "open-new-tab",
      "open-new-window",
      "split-right",
      "split-below",
    ]) {
      selectMenuValue(menu, kind);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    { returnsToGroups: false, removeLabel: "Remove from group" },
    { returnsToGroups: true, removeLabel: "Move back to Groups" },
  ])(
    "dispatches group choices with canonical radio roles (returns=$returnsToGroups)",
    async ({ returnsToGroups, removeLabel }) => {
      const onAction = vi.fn<(action: SessionMenuAction) => void>();
      const menu = await mountMenu({
        session: { category: "Research", categoryClearReturnsToGroups: returnsToGroups },
        groups: ["Research", "Projects"],
        onAction,
      });
      press(document, "1");
      expect(onAction).not.toHaveBeenCalled();
      const submenu = menuItem(menu, "Move to group");
      (submenu as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;
      expect(menuItemLabels(submenu)).toEqual(["Research", "Projects", removeLabel, "New group"]);
      expect(
        Array.from(
          submenu.querySelectorAll<HTMLElement>("wa-dropdown-item[slot='submenu']"),
          (item) => item.dataset.shortcut,
        ),
      ).toEqual(["1", "2", "3", "4"]);
      expect(
        menuItem(submenu, "Projects").querySelector(".session-menu__shortcut")?.textContent,
      ).toBe("2");
      const research = menuItem(submenu, "Research");
      const remove = menuItem(submenu, removeLabel);
      const create = menuItem(submenu, "New group");
      await Promise.all([research.updateComplete, remove.updateComplete, create.updateComplete]);
      await Promise.resolve();
      expect(research.getAttribute("role")).toBe("menuitemradio");
      expect(research.getAttribute("aria-checked")).toBe("true");
      expect(remove.getAttribute("role")).toBe("menuitem");
      expect(create.getAttribute("role")).toBe("menuitem");

      const keydown = press(document, "٢", { code: "Digit2" });
      expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });
      expect(keydown.defaultPrevented).toBe(true);
      onAction.mockClear();
      menuItem(menu, "Projects").click();
      expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });

      remove.click();
      expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: null });

      menuItem(menu, "New group").click();
      expect(onAction).toHaveBeenCalledWith({ kind: "new-group" });
    },
  );

  it.each([false, true])(
    "edits icon and color together without closing (compact=%s)",
    async (compact) => {
      const onAction = vi.fn<(action: SessionMenuAction) => void>();
      const onClose = vi.fn();
      const menu = await mountMenu({
        compact,
        session: { icon: "🦞", color: "blue" },
        onAction,
        onClose,
      });
      if (compact) {
        selectMenuValue(menu, "compact:open-icon");
        await menu.updateComplete;
      } else {
        (menuItem(menu, "Icon & color") as SessionMenuItem & { submenuOpen: boolean }).submenuOpen =
          true;
      }
      const blue = menu.querySelector<HTMLButtonElement>(
        '.session-menu__color-choice[aria-label="Blue"]',
      );
      expect(blue?.getAttribute("aria-pressed")).toBe("true");
      expect(menu.querySelectorAll('.session-menu__colors [aria-pressed="true"]')).toHaveLength(1);
      const choices = iconChoices(menu);
      const [emojiGrid, glyphGrid] = menu.querySelectorAll(".session-menu__icon-grid");
      const noIconChoices = [emojiGrid, glyphGrid].map((grid) =>
        grid?.querySelector<HTMLButtonElement>('.session-menu__icon-choice[aria-label="No icon"]'),
      );
      expect(
        noIconChoices.every((choice) => choice?.parentElement?.firstElementChild === choice),
      ).toBe(true);
      expect(choices[1]?.textContent?.trim()).toBe("🦞");
      expect(choices[1]?.getAttribute("role")).toBeNull();
      expect(choices[1]?.getAttribute("aria-pressed")).toBe("true");
      expect(choices.filter((choice) => choice.tabIndex === 0)).toEqual([choices[1]]);
      menu
        .querySelector<HTMLButtonElement>('.session-menu__color-choice[aria-label="Purple"]')
        ?.click();
      iconChoices(menu)[2]?.click();
      noIconChoices[0]?.click();
      noIconChoices[1]?.click();
      menu
        .querySelector<HTMLButtonElement>('.session-menu__color-choice[aria-label="No color"]')
        ?.click();
      const reset = menu.querySelector<HTMLButtonElement>(".session-menu__icon-remove");
      expect(reset?.previousElementSibling?.getAttribute("role")).toBe("separator");
      expect(reset?.textContent?.trim()).toBe("Reset to default");
      reset?.click();
      expect(onAction.mock.calls).toEqual([
        [{ kind: "set-color", color: "purple" }],
        [{ kind: "set-icon", icon: "🚀" }],
        [{ kind: "set-icon", icon: null }],
        [{ kind: "set-icon", icon: null }],
        [{ kind: "set-color", color: null }],
        [{ kind: "reset-appearance" }],
      ]);
      expect(onClose).not.toHaveBeenCalled();
      menu.session = { ...menu.session, icon: "🚀", color: "purple" };
      await menu.updateComplete;
      expect(
        menu.querySelector('.session-menu__icon-choice[aria-pressed="true"]')?.textContent?.trim(),
      ).toBe("🚀");
      expect(
        menu
          .querySelector('.session-menu__color-choice[aria-pressed="true"]')
          ?.getAttribute("aria-label"),
      ).toBe("Purple");
      menu.session = { ...menu.session, icon: null };
      await menu.updateComplete;
      const cleared = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('.session-menu__icon-choice[aria-pressed="true"]'),
      );
      expect(cleared.map((choice) => choice.getAttribute("aria-label"))).toEqual([
        "No icon",
        "No icon",
      ]);
      expect(cleared.map((choice) => choice.tabIndex)).toEqual([0, -1]);
    },
  );

  it.each([
    { selectionCount: 2 },
    { actionDisabledReasons: { "set-color": "Write access required" } },
  ])("does not dispatch a disabled color action: %j", async (options) => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ ...options, onAction });
    if (options.selectionCount === 2) {
      expect(menu.querySelector(".session-menu__appearance")).toBeNull();
    } else {
      for (const label of ["Red", "No color"]) {
        const choice = menu.querySelector<HTMLButtonElement>(
          `.session-menu__color-choice[aria-label="${label}"]`,
        );
        expect(choice?.disabled).toBe(true);
        choice?.click();
      }
      const reset = menu.querySelector<HTMLButtonElement>(".session-menu__icon-remove");
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
    const submenu = menuItem(menu, "Icon & color");
    submenu.querySelector<HTMLButtonElement>('[aria-label="Custom icon…"]')?.click();
    await menu.updateComplete;

    const input = submenu.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input");
    const set = submenu.querySelector<HTMLButtonElement>(".session-menu__icon-set");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-label")).toBe("Custom icon");
    await waitForSolid(() => expect(document.activeElement).toBe(input));
    expect(set?.disabled).toBe(true);

    if (!input) {
      throw new Error("Expected custom emoji input");
    }
    input.value = "a";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await menu.updateComplete;
    expect(submenu.querySelector<HTMLButtonElement>(".session-menu__icon-set")?.disabled).toBe(
      true,
    );

    input.value = value;
    expect(input.value).toBe(value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await menu.updateComplete;
    expect(submenu.querySelector<HTMLButtonElement>(".session-menu__icon-set")?.disabled).toBe(
      false,
    );
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
    const submenu = menuItem(menu, "Icon & color");
    const braces = submenu.querySelector<HTMLButtonElement>('[aria-label="braces"]');
    expect(braces?.getAttribute("aria-pressed")).toBe("true");
    expect(braces?.tabIndex).toBe(0);
    submenu.querySelector<HTMLButtonElement>('[aria-label="Custom icon…"]')?.click();
    await menu.updateComplete;
    const input = submenu.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input");
    if (!input) {
      throw new Error("Expected custom emoji input");
    }

    press(input, "Escape");
    await menu.updateComplete;

    const customEntry = input.closest(".session-menu__icon-custom-entry");
    expect(customEntry?.getAttribute("aria-hidden")).toBe("true");
    expect(customEntry?.hasAttribute("inert")).toBe(true);
    expect(submenu.querySelector(".session-menu__icon-options")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(submenu.querySelector('[aria-label="Custom icon…"]'));
    const currentIcon = submenu.querySelector<HTMLButtonElement>(
      '.session-menu__icon-options button[tabindex="0"]',
    );
    const reset = submenu.querySelector<HTMLButtonElement>(".session-menu__icon-remove");
    if (!currentIcon || !reset) {
      throw new Error("Expected the current icon and reset control");
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
    const submenu = menuItem(menu, "Icon & color");
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
    "renders unassigned group choices $groups in submenu slots",
    async ({ groups }) => {
      const menu = await mountMenu({ groups });
      const submenu = menuItem(menu, "Move to group");
      expect(menuItemLabels(submenu)).toEqual([...groups, "New group"]);
      expect(submenu.querySelector("wa-dropdown-item")?.getAttribute("slot")).toBe("submenu");
    },
  );

  it.each([
    { name: "absent", work: null },
    { name: "unresolved", work: { loading: true, pullRequestUrl: null, worktreePath: null } },
    {
      name: "PR",
      work: {
        loading: false,
        pullRequestUrl: "https://github.com/openclaw/openclaw/pull/12345",
        worktreePath: null,
      },
    },
    {
      name: "editor",
      work: { loading: false, pullRequestUrl: null, worktreePath: "/work/trees/demo" },
    },
  ])("offers and dispatches only resolved workspace destinations: $name", async ({ work }) => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ work, onAction });
    const openIn = menuItem(menu, "Open in");
    expect(menuItemLabels(openIn)).toEqual([
      "New tab",
      "New window",
      ...(work?.worktreePath ? ["Cursor", "VS Code", "Windsurf", "Zed"] : []),
    ]);
    if (work?.pullRequestUrl) {
      const openPr = menuItem(menu, "Open PR");
      expect(openPr.disabled).toBe(false);
      expect(openPr.hasAttribute("data-new-tab-action")).toBe(true);
      expect(openPr.querySelector(".session-menu__shortcut")?.textContent).toBe("G");
      press(document, "g");
      expect(onAction.mock.calls).toEqual([[{ kind: "open-pr", url: work.pullRequestUrl }]]);
    } else {
      expect(menuItemLabels(menu)).not.toContain("Open PR");
    }
    if (work?.worktreePath) {
      (openIn as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;
      menuItem(openIn, "VS Code").click();
      expect(onAction).toHaveBeenCalledWith({
        kind: "open-in",
        editor: "vscode",
        path: work.worktreePath,
      });
    }
  });

  it("renders shortcut hints and dispatches actions from bare letter keys", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action.kind),
    });

    const pin = menuItem(menu, "Pin session");
    expect(pin.querySelector(".session-menu__shortcut")?.textContent).toBe("P");
    expect(pin.getAttribute("aria-keyshortcuts")).toBe("P");
    expect(menuItem(menu, "Move to group").dataset.shortcut).toBeUndefined();

    const keydown = press(document, "з", { code: "KeyP" });
    expect(calls).toEqual(["close", "toggle-pin"]);
    expect(keydown.defaultPrevented).toBe(true);
  });

  it("ignores shortcut keys for disabled items and modified keystrokes", async () => {
    const onAction = vi.fn();
    await mountMenu({ archiveAllowed: false, onAction });

    press(document, "d");
    press(document, "p", { metaKey: true });
    press(document, "x");

    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "restores Tab focus only when leaving a menu item (outside=%s)",
    async (outside) => {
      const trigger = focusButton();
      const menu = await mountMenu({ trigger });
      const item = outside ? focusButton() : menuItem(menu, "Pin session");
      item.focus();
      const keydown = press(item, "Tab");
      expect(document.activeElement).toBe(outside ? item : trigger);
      expect(keydown.defaultPrevented).toBe(false);
    },
  );

  it.each(["Escape", "wa-after-hide"])(
    "closes on %s with the appropriate focus ownership",
    async (event) => {
      const trigger = focusButton();
      const onClose = vi.fn();
      const menu = await mountMenu({ trigger, onClose });
      const escaped = vi.fn();
      menu.addEventListener("keydown", escaped);
      if (event === "Escape") {
        press(menu, event);
        expect(document.activeElement).toBe(trigger);
      } else {
        menu
          .querySelector("wa-dropdown")
          ?.dispatchEvent(new CustomEvent(event, { bubbles: true, composed: true }));
        expect(document.activeElement).not.toBe(trigger);
      }
      expect(escaped).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores a stale hide after reopening the same session", async () => {
    const onClose = vi.fn();
    const menu = await mountMenu({ onClose });
    const staleDropdown = menu.querySelector("wa-dropdown");

    menu.anchor = { x: 120, y: 120 };
    await menu.updateComplete;
    staleDropdown?.dispatchEvent(
      new CustomEvent("wa-after-hide", { bubbles: true, composed: true }),
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(menu.querySelector("wa-dropdown")).not.toBe(staleDropdown);
  });
});

describe("sidebar snooze menu", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])(
    "dispatches the selected wake time from the preset submenu (compact: %s)",
    async (compact) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = new Date(2026, 8, 29, 9);
      vi.setSystemTime(now);
      const onAction = vi.fn<(action: SessionMenuAction) => void>();
      const menu = await mountMenu({ snoozeAllowed: true, compact, onAction });
      if (compact) {
        selectMenuValue(menu, "compact:open-snooze");
        await menu.updateComplete;
      }
      const labels = menuItemLabels(compact ? menu : menuItem(menu, "Snooze"));
      expect(labels.filter((label) => label.includes(" · "))).toEqual([
        "In 1 hour · 10:00 AM",
        "In 3 hours · 12:00 PM",
        "This evening · 6:00 PM",
        "Tomorrow · 9:00 AM",
        "Next week · Mon 9:00 AM",
      ]);
      const value = menuItem(menu, "This evening · 6:00 PM").getAttribute("value")!;
      selectMenuValue(menu, value);
      expect(onAction).toHaveBeenCalledWith({
        kind: "snooze",
        snoozedUntil: new Date(2026, 8, 29, 18).getTime(),
      });
    },
  );

  it("offers Wake session with the scheduled time and treats expired snoozes as awake", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(2026, 8, 29, 9).getTime();
    vi.setSystemTime(now);
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      snoozeAllowed: true,
      session: { snoozedUntil: now + 3_600_000 },
      onAction,
    });
    expect(menuItemLabels(menu)).toContain("Wake session · 10:00 AM");
    expect(menuItemLabels(menu)).not.toContain("Snooze");
    selectMenuValue(menu, "wake");
    expect(onAction).toHaveBeenCalledWith({ kind: "wake" });
    menu.session = { ...menu.session, snoozedUntil: now };
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toContain("Snooze");
    expect(menuItemLabels(menu).some((label) => label.startsWith("Wake session"))).toBe(false);
  });

  it.each([{ archived: true }, { isChild: true }, { pinnable: false }])(
    "omits snooze actions for ineligible rows %j",
    async (session) => {
      const onAction = vi.fn<(action: SessionMenuAction) => void>();
      const menu = await mountMenu({ snoozeAllowed: true, session, onAction });
      expect(menuItemLabels(menu)).not.toContain("Snooze");
      expect(menuItemLabels(menu).some((label) => label.startsWith("Wake session"))).toBe(false);
      selectMenuValue(menu, `snooze:${Date.now() + 3_600_000}`);
      selectMenuValue(menu, "wake");
      expect(onAction).not.toHaveBeenCalled();
    },
  );
});
