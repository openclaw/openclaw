import { createMemo, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { projectMutableSource } from "../../../lib/reactive/projection.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { buildSkillLibraryMock } from "../../../test-helpers/skill-library-fixtures.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ComposerSkillCatalog } from "../composer-capability-catalog.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import {
  docsServer,
  docsTools,
  makeCapabilities,
  makeMenu,
} from "./chat-composer-menu.test-support.ts";
import {
  ComposerMenuLoadingRows,
  renderComposerMenuOption as ComposerMenuOption,
} from "./chat-composer-menu.tsx";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps as Menu } from "./chat-composer-plus-menu.types.ts";
import { createSlashMenu, type SlashMenuHost } from "./chat-composer-slash-menu-state.ts";
import { SlashMenu } from "./chat-composer-slash-menu.tsx";

function mountSlashMenu(paneId: string) {
  const host: SlashMenuHost = {
    paneId,
    getDraft: () => "/",
    commitDraft: vi.fn(),
    getTextarea: () => null,
    resolveArgOptions: () => [],
    runCommand: vi.fn(),
    canRun: () => true,
  };
  let menu!: ReturnType<typeof createSlashMenu>;
  const view = mountSolid(() => {
    menu = createSlashMenu();
    return <SlashMenu menu={menu} host={host} draft="/" />;
  });
  menu.update("/", host);
  flush();
  return { menu, host, view };
}

it("keeps loading suggestions named, selected and actionable", () => {
  const select = vi.fn();
  const [activeId, setActiveId] = createSignal("pending-status");
  const view = mountSolid(() => (
    <div role="listbox" aria-label="Suggestions">
      <ComposerMenuLoadingRows
        activeId={activeId()}
        rows={[
          {
            id: "pending-status",
            name: "/status",
            description: "Show status",
            select,
            hover: () => setActiveId("pending-status"),
          },
          {
            id: "pending-help",
            name: "/help",
            description: "Show help",
            select,
            hover: () => setActiveId("pending-help"),
          },
        ]}
      />
    </div>
  ));
  const status = view.getByRole("option", { name: "/status Show status", selected: true });
  const help = view.getByRole("option", { name: "/help Show help", selected: false });
  help.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  flush();
  expect(view.getByRole("option", { selected: true })).toBe(help);
  expect(status.getAttribute("aria-selected")).toBe("false");
  help.click();
  expect(select).toHaveBeenCalledOnce();
});

it("keeps current editing state when suggestion rows load after dismissal", async () => {
  const { menu, host, view } = mountSlashMenu("lazy-menu-dismissal");
  expect(view.getByRole("listbox")).toBeTruthy();
  expect(view.container.querySelectorAll(".slash-menu-item")).toHaveLength(
    menu.state.slashMenuItems.length,
  );
  menu.reset();
  await import("./chat-composer-slash-menu-options.tsx");
  flush();
  expect(view.queryByRole("listbox")).toBeNull();

  menu.update("/", host);
  flush();
  menu.hover(menu.state.slashMenuItems.findIndex((entry) => entry.key === "status"));
  await waitForSolid(() => expect(view.getByRole("option", { selected: true })).toBeTruthy());
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status");
});

it("uses the current focus policy on a retained suggestion option", () => {
  let setPreserveFocus!: (value: boolean) => void;
  const view = mountSolid(() => {
    const [preserveFocus, update] = createSignal(true);
    setPreserveFocus = update;
    return (
      <ComposerMenuOption
        id="retained-option"
        active={false}
        preserveFocus={preserveFocus()}
        select={vi.fn()}
        hover={vi.fn()}
        icon={undefined}
        name="Suggestion"
        description=""
      />
    );
  });
  const option = view.getByRole("option");
  for (const preserve of [true, false, true]) {
    setPreserveFocus(preserve);
    flush();
    expect(view.getByRole("option")).toBe(option);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(preserve);
  }
});

it("retains the slash viewport through row loading and selection changes, and resets it for a new mode", async () => {
  const command = { key: "status", name: "status", description: "Show status" };
  const { menu, host, view } = mountSlashMenu("menu-retention");
  const viewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  viewport.scrollTop = 120;
  await waitForSolid(() => expect(view.getByRole("option", { selected: true })).toBeTruthy());
  expect(view.container.querySelector(".slash-menu__scroll")).toBe(viewport);
  menu.hover(menu.state.slashMenuItems.findIndex((entry) => entry.key === "status"));
  flush();
  expect(view.container.querySelector(".slash-menu__scroll")).toBe(viewport);
  expect(viewport.scrollTop).toBe(120);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status");

  host.resolveArgOptions = () => ["on", "off"];
  menu.selectCommand(command, host);
  flush();
  await waitForSolid(() => expect(view.getByRole("option", { selected: true })).toBeTruthy());
  const argumentsViewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  expect(argumentsViewport).not.toBe(viewport);
  expect(argumentsViewport.scrollTop).toBe(0);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status on");

  menu.reset();
  flush();
  expect(view.queryByRole("listbox")).toBeNull();
});

it("retains the focused capability row and management link through catalog refreshes", async () => {
  const onNavigate = vi.fn();
  const [menu, setMenu] = createSignal<Menu>(
    makeMenu({
      open: true,
      view: "skills",
      capabilityMenu: makeCapabilities({
        onOpenToolAccess: vi.fn(),
        skills: [
          { key: "focused", name: "Focused skill", enabled: true, baseEnabled: true },
          { key: "broken", name: "Broken", enabled: false, baseEnabled: false, missingDeps: true },
          { key: "private", name: "Private", enabled: false, baseEnabled: false, blocked: true },
        ],
        onNavigate,
      }),
    }),
  );
  const view = mountSolid(() => <ChatComposerPlusMenu menu={menu()} />);
  const checkbox = (name: string) => view.getByRole("menuitemcheckbox", { name, hidden: true });
  const update = (
    changes: Partial<Menu>,
    capability: Partial<NonNullable<ReturnType<NonNullable<Menu["capabilityMenu"]>["read"]>>> = {},
  ) =>
    setMenu((previous) => ({
      ...previous,
      ...changes,
      capabilityMenu: makeCapabilities({ ...previous.capabilityMenu!.read()!, ...capability }),
    }));
  await import("./chat-composer-plus-menu-content.tsx");
  await waitForSolid(() => expect(checkbox("Focused skill")).toBeTruthy());
  for (const [name, description] of [
    ["Broken", "deps missing"],
    ["Private", "not available for this agent"],
  ]) {
    expect(
      view.getByRole("menuitem", { name, description, hidden: true }).hasAttribute("disabled"),
    ).toBe(true);
  }
  const row = view.container.querySelector<HTMLButtonElement>('[data-value="skill:focused"]')!;
  await waitForSolid(() =>
    expect(row.closest("[data-menu-content]")?.getAttribute("data-phase")).toBe("open"),
  );
  expect(row.closest("[data-menu-content]")?.matches(":popover-open")).toBe(true);
  row.focus();
  expect(document.activeElement).toBe(row);

  update(
    { toolOverrides: { skills: { focused: false } } },
    {
      skills: [{ key: "focused", name: "Focused skill", enabled: false, baseEnabled: true }],
    },
  );
  flush();
  expect(view.container.querySelector('[data-value="skill:focused"]')).toBe(row);
  expect(document.activeElement).toBe(row);
  await waitForSolid(() => expect(row.getAttribute("aria-checked")).toBe("false"));

  update(
    {},
    {
      skillsRead: null,
      skills: [
        { key: "new", name: "New skill", enabled: true, baseEnabled: true },
        { key: "focused", name: "Refreshed skill", enabled: false, baseEnabled: true },
      ],
    },
  );
  await waitForSolid(() => {
    expect(view.container.querySelector('[data-value="skill:focused"]')).toBe(row);
    expect(row.textContent).toContain("Refreshed skill");
  });
  expect(row.getAttribute("aria-checked")).toBe("false");
  expect(document.activeElement).toBe(row);

  const manage = view.getByRole("menuitem", { name: "Manage skills", hidden: true });
  expect(manage.getAttribute("href")).toBe("/control/skills");
  const modifiedClick = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    metaKey: true,
  });
  manage.dispatchEvent(modifiedClick);
  expect(modifiedClick.defaultPrevented).toBe(false);
  expect(onNavigate).not.toHaveBeenCalled();
  manage.click();
  await waitForSolid(() => expect(onNavigate).toHaveBeenCalledExactlyOnceWith("skills"));

  update(
    {
      view: "connectors",
      toolOverrides: { mcpServers: { docs: true } },
    },
    { mcpServers: [docsServer(false)] },
  );
  await waitForSolid(() =>
    expect(view.getByRole("switch", { name: "docs", hidden: true })).toBeTruthy(),
  );
  const connector = view.getByRole("switch", { name: "docs", hidden: true });
  setMenu((previous) => ({ ...previous, toolOverrides: null }));
  await waitForSolid(() =>
    expect(view.getByRole("switch", { name: "docs", hidden: true })).toBe(connector),
  );

  update({}, { toolsEffectiveResult: docsTools(true) });
  (view.container.querySelector('[data-value="server:docs"]') as HTMLElement).click();
  await waitForSolid(() => {
    expect(checkbox("Search documents")).toBeTruthy();
    expect(checkbox("list")).toBeTruthy();
  });
});

it("retains attachment choices while the native menu closes and reopens", async () => {
  const base = makeMenu();
  const [open, setOpen] = createSignal(false);
  const toggle = {
    value: "test-toggle",
    label: "Test toggle",
    checked: false,
    disabled: false,
    onChange: vi.fn(),
  };
  const view = mountSolid(() => (
    <ChatComposerPlusMenu
      menu={{
        ...base,
        open: open(),
        rootToggles: [{ ...toggle, icon: "pencil" }],
        onOpenChange: setOpen,
        onViewChange: vi.fn(),
      }}
    />
  ));
  const trigger = view.container.querySelector<HTMLButtonElement>(
    ".agent-chat__input-btn--attach",
  )!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  await import("./chat-composer-plus-menu-content.tsx");
  await waitForSolid(() =>
    expect(view.getByRole("menuitemcheckbox", { name: "Test toggle", hidden: true })).toBeTruthy(),
  );
  const choice = view.getByRole("menuitemcheckbox", { name: "Test toggle", hidden: true });
  expect(choice.querySelector("svg")).not.toBeNull();
  setOpen(false);
  flush();
  setOpen(true);
  flush();
  expect(view.container.querySelector('[data-value="test-toggle"]')).toBe(choice);
});

it.each(["item", "external", "closed"] as const)(
  "preserves newer %s focus after changing capability views",
  async (target) => {
    const base = makeMenu();
    const [currentView, setView] = createSignal<Menu["view"]>("connectors");
    const [open, setOpen] = createSignal(true);
    const view = mountSolid(() => (
      <>
        <input aria-label="Newer focus" />
        <ChatComposerPlusMenu
          menu={{
            ...base,
            open: open(),
            view: currentView(),
            onOpenChange: setOpen,
            onViewChange: setView,
            capabilityMenu: makeCapabilities({ mcpServers: [docsServer(true)] }),
          }}
        />
      </>
    ));
    await import("./chat-composer-plus-menu-content.tsx");
    await waitForSolid(() =>
      expect(view.getByRole("menuitem", { name: "Plugins", hidden: true })).toBeTruthy(),
    );
    const back = view.getByRole("menuitem", { name: "Plugins", hidden: true });
    await waitForSolid(() =>
      expect(back.closest("[data-menu-content]")?.getAttribute("data-phase")).toBe("open"),
    );
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      back.focus();
      back.click();
      let focused: HTMLElement;
      if (target === "item") {
        flush();
        focused = view.getByRole("menuitem", { name: "Skills", hidden: true });
      } else if (target === "closed") {
        setOpen(false);
        focused = document.body;
      } else {
        focused = view.getByRole("textbox", { name: "Newer focus" });
      }
      if (target !== "closed") {
        focused.focus();
      }
      flush();
      for (const callback of frames) {
        callback(0);
      }
      expect(document.activeElement).toBe(focused);
    } finally {
      raf.mockRestore();
    }
  },
);

it("keeps skill navigation live through failure, retry and a retired connection read", async () => {
  const failed = createDeferred<unknown>();
  const retired = createDeferred<unknown>();
  const current = createDeferred<unknown>();
  for (const request of [failed, retired, current]) {
    onTestFinished(() => request.resolve({ skills: [] }));
  }
  const request = vi
    .fn()
    .mockReturnValueOnce(failed.promise)
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(current.promise);
  // SAFETY: the catalog only consumes the Gateway request contract in this fixture.
  const client = { request } as unknown as GatewayBrowserClient;
  let epoch = 1;
  let overrides: SessionToolOverrides | null = null;
  let publish = () => {};
  const catalog = new ComposerSkillCatalog(() => publish());
  const [selectedSkill, availableSkill] = buildSkillLibraryMock();
  const library: ComposerLibraryProps = {
    result: {
      entries: [selectedSkill.entry, availableSkill.entry],
      profileId: "profile-alice",
      multipleProfiles: true,
      defaultTarget: "personal",
      canManageWorkspace: false,
      defaultSelectionLimit: 64,
      session: {
        sessionKey: "main",
        selections: [{ ...selectedSkill.entry }],
        attachable: [availableSkill.entry],
      },
    },
    loading: false,
    busy: false,
    error: null,
    canWrite: true,
    onReload: vi.fn(),
    onRead: vi.fn(),
    onActivate: vi.fn(),
  };
  const load = () => {
    const admittedEpoch = epoch;
    catalog.load(client, admittedEpoch, "main", () => admittedEpoch === epoch);
  };
  const view = mountSolid(() => {
    const projection = projectMutableSource(catalog, (owner) => ({
      skills: owner.rows("main", overrides),
      skillsRead: owner.read("main"),
    }));
    publish = projection.publish;
    const [open, setOpen] = createSignal(false);
    const [selected, setSelected] = createSignal<Menu["view"]>("root");
    const menu = createMemo(() =>
      makeMenu({
        open: open(),
        view: selected(),
        toolOverrides: overrides,
        onOpenChange: setOpen,
        onViewChange: setSelected,
        capabilityMenu: makeCapabilities({
          ...projection.read(),
          library,
          onLoadSkills: load,
          onPatchToolOverrides: (next) => {
            overrides = next;
            publish();
          },
        }),
      }),
    );
    return <ChatComposerPlusMenu menu={menu()} />;
  });
  const trigger = view.container.querySelector<HTMLButtonElement>(
    ".agent-chat__input-btn--attach",
  )!;
  const panel = view.container.querySelector<HTMLElement>(".agent-chat__capability-menu-panel")!;
  expect(request).not.toHaveBeenCalled();
  trigger.click();
  await import("./chat-composer-plus-menu-content.tsx");
  await waitForSolid(() =>
    expect(view.getByRole("menuitem", { name: "Skills", hidden: true })).toBeTruthy(),
  );
  view.getByRole("menuitem", { name: "Skills", hidden: true }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").getAttribute("aria-label")).toContain("Loading skills"),
  );
  view.getByRole("menuitem", { name: "release-notes Alice", hidden: true }).click();
  await waitForSolid(() =>
    expect(view.getByRole("menuitem", { name: "Read skill", hidden: true })).toBeTruthy(),
  );
  view.getByRole("menuitem", { name: "Read skill", hidden: true }).click();
  expect(library.onRead).toHaveBeenCalledExactlyOnceWith(
    selectedSkill.entry.skillId,
    selectedSkill.entry.revision,
  );
  view.getByRole("menuitem", { name: "release-notes", hidden: true }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").getAttribute("aria-label")).toContain("Loading skills"),
  );
  const back = view.getByRole("menuitem", { name: "Skills", hidden: true });
  let manage = view.getByRole("menuitem", { name: "Manage skills", hidden: true });
  const libraryRow = view.getByRole("menuitem", { name: "release-notes Alice", hidden: true });
  const libraryAdd = view.getByRole("menuitem", { name: "Add from libraries", hidden: true });
  back.focus();
  back.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() => expect(document.activeElement).toBe(libraryRow));
  failed.reject(new Error("Synthetic skill read failure"));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Couldn’t load skills"),
  );
  expect(panel.matches(":popover-open")).toBe(true);
  expect(view.getByRole("menuitem", { name: "Skills", hidden: true })).toBe(back);
  expect(view.getByRole("menuitem", { name: "Manage skills", hidden: true })).toBe(manage);
  expect(view.getByRole("menuitem", { name: "release-notes Alice", hidden: true })).toBe(
    libraryRow,
  );
  expect(view.getByRole("menuitem", { name: "Add from libraries", hidden: true })).toBe(libraryAdd);
  expect(document.activeElement).toBe(libraryRow);
  libraryAdd.click();
  await waitForSolid(() =>
    expect(
      view.container.querySelector(`[data-value="library-attach:${availableSkill.entry.skillId}"]`),
    ).not.toBeNull(),
  );
  (
    view.container.querySelector(
      `[data-value="library-attach:${availableSkill.entry.skillId}"]`,
    ) as HTMLButtonElement
  ).click();
  expect(library.onActivate).toHaveBeenCalledExactlyOnceWith(
    "attach",
    availableSkill.entry.skillId,
    availableSkill.entry.revision,
  );
  view.getByRole("menuitem", { name: "Add from libraries", hidden: true }).click();
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Couldn’t load skills"),
  );
  manage = view.getByRole("menuitem", { name: "Manage skills", hidden: true });
  trigger.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  trigger.click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").getAttribute("aria-label")).toContain("Loading skills");
  });
  trigger.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  epoch = 2;
  catalog.synchronize(client, epoch);
  publish();
  trigger.click();
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
  const skill = (name: string) => ({
    name,
    skillKey: name,
    disabled: false,
    blockedByAllowlist: false,
    missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
  });
  retired.resolve({ skills: [skill("Retired skill")] });
  overrides = { skills: { Current: false } };
  publish();
  await Promise.resolve();
  flush();
  expect(view.queryByRole("menuitemcheckbox", { name: "Retired skill", hidden: true })).toBeNull();
  expect(view.getByRole("status").getAttribute("aria-label")).toContain("Loading skills");
  current.resolve({ skills: [skill("Current")] });
  await waitForSolid(() =>
    expect(
      view
        .getByRole("menuitemcheckbox", { name: "Current", hidden: true })
        .getAttribute("aria-checked"),
    ).toBe("false"),
  );
  expect(view.container.querySelector(".agent-chat__input-btn--attach")).toBe(trigger);
  expect(view.getByRole("menuitem", { name: "Skills", hidden: true })).toBe(back);
  expect(view.getByRole("menuitem", { name: "Manage skills", hidden: true })).toBe(manage);
  expect(
    view
      .getByRole("menuitem", { name: "release-notes Alice", hidden: true })
      .hasAttribute("disabled"),
  ).toBe(false);
  const recoveredLibraryAdd = view.getByRole("menuitem", {
    name: "Add from libraries",
    hidden: true,
  });
  expect(recoveredLibraryAdd.hasAttribute("disabled")).toBe(false);
  recoveredLibraryAdd.focus();
  recoveredLibraryAdd.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
  const row = view.getByRole("menuitemcheckbox", { name: "Current", hidden: true });
  await waitForSolid(() => expect(document.activeElement).toBe(row));
  row.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await waitForSolid(() => expect(catalog.rows("main", overrides)?.[0]?.enabled).toBe(true));
  await waitForSolid(() => expect(row.getAttribute("aria-checked")).toBe("true"));
  expect(panel.matches(":popover-open")).toBe(true);
});

it("filters skills across groups and restores the catalog when header search closes", async () => {
  const base = makeMenu({
    open: true,
    view: "skills",
    capabilityMenu: makeCapabilities({
      skills: [
        { key: "notes", name: "Notes", enabled: true, baseEnabled: true },
        { key: "nfd", name: "e\u0301", enabled: false, baseEnabled: false, missingDeps: true },
      ],
    }),
  });
  const [menu, setMenu] = createSignal(base);
  const view = mountSolid(() => <ChatComposerPlusMenu menu={menu()} />);
  await waitForSolid(() =>
    expect(view.queryByRole("button", { name: "Search skills", hidden: true })).not.toBeNull(),
  );
  view.getByRole("button", { name: "Search skills", hidden: true }).click();
  await waitForSolid(() =>
    expect(view.queryByRole("textbox", { name: "Search skills", hidden: true })).not.toBeNull(),
  );
  const input = view.getByRole("textbox", {
    name: "Search skills",
    hidden: true,
  }) as HTMLInputElement;
  input.value = "É";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitForSolid(() => {
    expect(view.queryByRole("menuitemcheckbox", { name: "Notes", hidden: true })).toBeNull();
    expect(
      view.getByRole("menuitem", { name: "e\u0301", hidden: true }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
  input.value = "missing";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitForSolid(() =>
    expect(view.container.textContent).toContain("No skills match your search."),
  );
  view.getByRole("menuitem", { name: "Skills", hidden: true }).click();
  await waitForSolid(() => {
    expect(view.queryByRole("textbox", { name: "Search skills", hidden: true })).toBeNull();
    expect(view.getByRole("menuitemcheckbox", { name: "Notes", hidden: true })).not.toBeNull();
    expect(view.getByRole("menuitem", { name: "e\u0301", hidden: true })).not.toBeNull();
  });
  setMenu((previous) => ({ ...previous, view: "libraries" }));
  await waitForSolid(() => {
    expect(view.getByRole("menuitem", { name: "Add from libraries", hidden: true })).not.toBeNull();
    expect(view.queryByRole("button", { name: "Search skills", hidden: true })).toBeNull();
  });
  setMenu((previous) => ({
    ...previous,
    view: "library:release",
    capabilityMenu: makeCapabilities({
      ...previous.capabilityMenu!.read()!,
      library: {
        loading: false,
        busy: false,
        error: null,
        canWrite: true,
        onRead: vi.fn(),
        onActivate: vi.fn(),
        onReload: vi.fn(),
        result: {
          entries: [],
          profileId: "alice",
          multipleProfiles: false,
          defaultTarget: "personal",
          canManageWorkspace: false,
          defaultSelectionLimit: 10,
          session: {
            sessionKey: "main",
            attachable: [],
            selections: [
              {
                skillId: "release",
                name: "release-notes",
                slug: "release-notes",
                description: "Draft release notes",
                revision: "a".repeat(64),
                ownerProfileId: "alice",
                ownerLabel: "Alice",
              },
            ],
          },
        },
      },
    }),
  }));
  await waitForSolid(() =>
    expect(view.getByRole("menuitem", { name: "release-notes", hidden: true })).not.toBeNull(),
  );
  setMenu((previous) => ({ ...previous, view: "connectors" }));
  await waitForSolid(() =>
    expect(view.getByRole("menuitem", { name: "Plugins", hidden: true })).not.toBeNull(),
  );
});

it("expands one server at a time and keeps switch and bulk tool actions separate", async () => {
  const patch = vi.fn();
  const open = vi.fn();
  const [overrides, setOverrides] = createSignal<SessionToolOverrides | null>(null);
  const base = makeMenu({ open: true, view: "connectors" });
  const [currentView, setCurrentView] = createSignal<Menu["view"]>("connectors");
  const view = mountSolid(() => (
    <ChatComposerPlusMenu
      menu={{
        ...base,
        view: currentView(),
        toolOverrides: overrides(),
        capabilityMenu: makeCapabilities({
          mcpServers: [docsServer(true), { ...docsServer(true), name: "other" }],
          toolsEffectiveResult: docsTools(true),
          onOpenToolAccess: open,
          onPatchToolOverrides: (value) => {
            patch(value);
            setOverrides(value);
          },
        }),
      }}
    />
  ));
  await waitForSolid(() =>
    expect(view.queryByRole("switch", { name: "docs", hidden: true })).not.toBeNull(),
  );
  view.getByRole("switch", { name: "docs", hidden: true }).click();
  await waitForSolid(() => expect(patch).toHaveBeenLastCalledWith({ mcpServers: { docs: false } }));
  expect(open).not.toHaveBeenCalled();
  view.getByRole("menuitem", { name: "docs", hidden: true }).click();
  await waitForSolid(() =>
    expect(
      view.queryByRole("menuitemcheckbox", { name: "Search documents", hidden: true }),
    ).not.toBeNull(),
  );
  view.getByRole("menuitem", { name: "Turn all off", hidden: true }).click();
  await waitForSolid(() =>
    expect(patch).toHaveBeenLastCalledWith({
      mcpServers: { docs: false },
      mcpToolsDeny: { docs: ["list", "search"] },
    }),
  );
  view.getByRole("menuitem", { name: "other", hidden: true }).click();
  await waitForSolid(() =>
    expect(
      view.queryByRole("menuitemcheckbox", { name: "Search documents", hidden: true }),
    ).toBeNull(),
  );
  expect(open).toHaveBeenLastCalledWith("other");
  setCurrentView("root");
  await waitForSolid(() =>
    expect(
      view.queryByRole("menuitem", { name: "2 changes for this session", hidden: true }),
    ).not.toBeNull(),
  );
  view.getByRole("menuitem", { name: "2 changes for this session", hidden: true }).click();
  await waitForSolid(() => {
    expect(patch).toHaveBeenLastCalledWith(null);
    expect(overrides()).toBeNull();
    expect(
      view.queryByRole("menuitem", { name: /changes for this session/, hidden: true }),
    ).toBeNull();
  });
});

it("keeps colliding tool labels distinct without replacing unique friendly labels", async () => {
  const tools = docsTools(true);
  const [dash, underscore] = tools.groups[0]!.tools;
  dash!.mcpToolName = "search-items";
  underscore!.mcpToolName = "search_items";
  dash!.label = underscore!.label = "search_items";
  tools.groups[0]!.tools.push(
    { ...dash!, id: "docs_find", mcpToolName: "find", label: "search-items" },
    { ...dash!, id: "docs_lookup", mcpToolName: "lookup", label: "find" },
  );
  tools.groups[0]!.tools.push({
    ...dash!,
    id: "docs_read",
    mcpToolName: "read",
    label: "Read documents",
  });
  const patch = vi.fn();
  const menu = makeMenu({
    open: true,
    view: "connectors",
    capabilityMenu: makeCapabilities({
      mcpServers: [docsServer(true)],
      toolsEffectiveResult: tools,
      onOpenToolAccess: vi.fn(),
      onPatchToolOverrides: patch,
    }),
  });
  const view = mountSolid(() => <ChatComposerPlusMenu menu={menu} />);
  await waitForSolid(() =>
    expect(view.queryByRole("menuitem", { name: "docs", hidden: true })).not.toBeNull(),
  );
  view.getByRole("menuitem", { name: "docs", hidden: true }).click();
  await waitForSolid(() =>
    expect(
      view.queryByRole("menuitemcheckbox", { name: "search-items", hidden: true }),
    ).not.toBeNull(),
  );
  expect(view.getByRole("menuitemcheckbox", { name: "search_items", hidden: true })).not.toBeNull();
  expect(view.getByRole("menuitemcheckbox", { name: "find", hidden: true })).not.toBeNull();
  expect(view.getByRole("menuitemcheckbox", { name: "lookup", hidden: true })).not.toBeNull();
  expect(
    view.getByRole("menuitemcheckbox", { name: "Read documents", hidden: true }),
  ).not.toBeNull();
  view.getByRole("menuitemcheckbox", { name: "search-items", hidden: true }).click();
  expect(patch).toHaveBeenCalledExactlyOnceWith({ mcpToolsDeny: { docs: ["search-items"] } });
});

it.each(["mcp-not-yet-connected", "mcp-not-yet-listed", "mcp-stale-catalog"])(
  "shows the Gateway discovery guidance without a failure or Retry (%s)",
  async (id) => {
    const message = "MCP tools will appear here after the next agent run discovers them.";
    const tools = {
      ...docsTools(),
      groups: [],
      notices: [{ id, severity: "info" as const, message, servers: ["docs"] }],
    };
    const menu = makeMenu({
      open: true,
      view: "connectors",
      capabilityMenu: makeCapabilities({
        mcpServers: [docsServer(true)],
        toolsEffectiveResult: tools,
        onOpenToolAccess: vi.fn(),
      }),
    });
    const view = mountSolid(() => <ChatComposerPlusMenu menu={menu} />);
    await waitForSolid(() =>
      expect(view.queryByRole("menuitem", { name: "docs", hidden: true })).not.toBeNull(),
    );
    view.getByRole("menuitem", { name: "docs", hidden: true }).click();
    await waitForSolid(() => expect(view.getByRole("status").textContent).toBe(message));
    expect(view.queryByRole("button", { name: "Retry", hidden: true })).toBeNull();
    expect(view.container.textContent).not.toContain("The server didn’t respond.");
  },
);
