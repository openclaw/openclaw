import { createMemo, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { projectMutableSource } from "../../../lib/reactive/projection.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ComposerSkillCatalog } from "../composer-capability-catalog.ts";
import { docsServer, makeCapabilities, makeMenu } from "./chat-composer-menu.test-support.ts";
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
  return { host, menu, view };
}

function menuQueries(view: ReturnType<typeof mountSolid>) {
  return {
    item: (name: string) => view.getByRole("menuitem", { name, hidden: true }),
    checkbox: (name: string) => view.getByRole("menuitemcheckbox", { name, hidden: true }),
    key: (target: HTMLElement, key: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    trigger: () =>
      view.container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")!,
  };
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
  const { item, checkbox } = menuQueries(view);
  const update = (
    changes: Partial<Menu>,
    capability: Partial<NonNullable<Menu["capabilityMenu"]>> = {},
  ) =>
    setMenu((previous) => ({
      ...previous,
      ...changes,
      capabilityMenu: { ...previous.capabilityMenu!, ...capability },
    }));
  await waitForSolid(() => expect(checkbox("Focused skill")).toBeTruthy());
  for (const name of ["Broken deps missing", "Private not available for this agent"]) {
    expect(checkbox(name).hasAttribute("disabled")).toBe(true);
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

  const manage = item("Manage skills");
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
  const { checkbox, trigger: readTrigger } = menuQueries(view);
  const trigger = readTrigger();
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  await waitForSolid(() => expect(checkbox("Test toggle")).toBeTruthy());
  const choice = checkbox("Test toggle");
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
    const [currentView, setView] = createSignal<Menu["view"]>(
      target === "closed" ? "connectors" : "tools:docs",
    );
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
    const { item, checkbox } = menuQueries(view);
    await waitForSolid(() => expect(item("Back")).toBeTruthy());
    const back = item("Back");
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
        expect(document.activeElement).toBe(back);
        focused = checkbox("docs Enabled");
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
      if (target === "item") {
        back.focus();
        back.click();
        flush();
        expect(back.isConnected).toBe(false);
        expect(document.activeElement).toBe(item("Take photo"));
      }
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
  const { item, checkbox, key, trigger: readTrigger } = menuQueries(view);
  const trigger = readTrigger();
  const panel = view.container.querySelector<HTMLElement>(".agent-chat__capability-menu-panel")!;
  expect(request).not.toHaveBeenCalled();
  trigger.click();
  await waitForSolid(() => expect(item("Skills")).toBeTruthy());
  item("Skills").click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Loading skills"),
  );
  const back = item("Back");
  const manage = item("Manage skills");
  back.focus();
  key(back, "ArrowDown");
  await waitForSolid(() => expect(document.activeElement).toBe(manage));
  failed.reject(new Error("Synthetic skill read failure"));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Couldn’t load skills"),
  );
  expect(panel.matches(":popover-open")).toBe(true);
  expect(item("Back")).toBe(back);
  expect(item("Manage skills")).toBe(manage);
  trigger.click();
  await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(false));
  trigger.click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("Loading skills");
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
  expect(view.getByRole("status").textContent).toContain("Loading skills");
  current.resolve({ skills: [skill("Current")] });
  await waitForSolid(() => expect(checkbox("Current").getAttribute("aria-checked")).toBe("false"));
  expect(view.container.querySelector(".agent-chat__input-btn--attach")).toBe(trigger);
  expect(item("Back")).toBe(back);
  expect(item("Manage skills")).toBe(manage);
  back.focus();
  key(back, "ArrowDown");
  const row = checkbox("Current");
  await waitForSolid(() => expect(document.activeElement).toBe(row));
  key(row, "Enter");
  await waitForSolid(() => expect(catalog.rows("main", overrides)?.[0]?.enabled).toBe(true));
  await waitForSolid(() => expect(row.getAttribute("aria-checked")).toBe("true"));
  expect(panel.matches(":popover-open")).toBe(true);
});
