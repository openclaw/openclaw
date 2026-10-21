import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  docsServer,
  docsTools,
  makeCapabilities,
  makeMenu,
} from "./chat-composer-menu.test-support.ts";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps as Menu } from "./chat-composer-plus-menu.types.ts";
import { createSlashMenu, SlashMenu, type SlashMenuHost } from "./chat-composer-slash-menu.tsx";

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

it("retains the slash viewport during selection changes and resets it when switching mode", () => {
  const command = { key: "status", name: "status", description: "Show status" };
  const host: SlashMenuHost = {
    paneId: "menu-retention",
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
  const viewport = view.container.querySelector<HTMLElement>(".slash-menu__scroll")!;
  viewport.scrollTop = 120;
  menu.hover(menu.state.slashMenuItems.findIndex((entry) => entry.key === "status"));
  flush();
  expect(view.container.querySelector(".slash-menu__scroll")).toBe(viewport);
  expect(viewport.scrollTop).toBe(120);
  expect(view.getByRole("option", { selected: true }).textContent).toContain("/status");

  host.resolveArgOptions = () => ["on", "off"];
  menu.selectCommand(command, host);
  flush();
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
  const checkbox = (name: string) => view.getByRole("menuitemcheckbox", { name, hidden: true });
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
    {},
    {
      skillsLoading: true,
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
      skillsLoading: false,
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
  await waitForSolid(() => expect(checkbox("docs Enabled session")).toBeTruthy());
  const connector = checkbox("docs Enabled session");
  setMenu((previous) => ({ ...previous, toolOverrides: null }));
  await waitForSolid(() => expect(checkbox("docs Disabled")).toBe(connector));

  update({ view: "tools:docs" }, { toolsEffectiveResult: docsTools(true) });
  await waitForSolid(() => {
    expect(checkbox("search Search documents")).toBeTruthy();
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
    await waitForSolid(() =>
      expect(view.getByRole("menuitem", { name: "Back", hidden: true })).toBeTruthy(),
    );
    const back = view.getByRole("menuitem", { name: "Back", hidden: true });
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
        focused = view.getByRole("menuitemcheckbox", { name: "docs Enabled", hidden: true });
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
        expect(document.activeElement).toBe(
          view.getByRole("menuitem", { name: "Take photo", hidden: true }),
        );
      }
    } finally {
      raf.mockRestore();
    }
  },
);
