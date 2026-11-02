import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  item,
  mountMenu,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import { MultiSelect } from "../multi-select.tsx";
import {
  keyFocus as press,
  keyPhase,
  mountControls,
  submenu,
  tabFocus as tabTo,
} from "./menu-contract.test-support.tsx";
import { Menu, type MenuEntry, type MenuItem, type MenuProps } from "./menu.tsx";
import { Popover, type PopoverHandle } from "./popover.tsx";

afterEach(cleanup);

describe("Solid menu navigation", () => {
  it.each([true, "while-open"] as const)("owns lazy content across reopen (%s)", async (lazy) => {
    let itemReads = 0;
    let childrenReads = 0;
    const [label, setLabel] = createSignal("Ready");
    const [placement, setPlacement] = createSignal<"bottom-start" | "top-end">("bottom-start");
    const view = mountMenu({
      lazy,
      get placement() {
        return placement();
      },
      get items() {
        itemReads += 1;
        return [{ id: "ready", label: label() }];
      },
      get children() {
        childrenReads += 1;
        return <span>Lazy heading</span>;
      },
    });
    expect(itemReads).toBe(0);
    expect(childrenReads).toBe(0);
    const button = trigger();
    const panel = surface();
    expect(panel.querySelector("[role=menuitem]")).toBeNull();
    expect(button.style.getPropertyValue("anchor-name")).toBe("");
    expect(panel.style.getPropertyValue("position-anchor")).toBe("");
    setPlacement("top-end");
    flush();
    trigger().focus();
    await keyPhase("{ArrowDown}", "open");
    const ready = item("Ready");
    expect(document.activeElement).toBe(ready);
    expect(childrenReads).toBe(1);
    const anchorName = button.style.getPropertyValue("anchor-name");
    expect(anchorName).toMatch(/^--oc-overlay-/);
    expect(panel.style.getPropertyValue("position-anchor")).toBe(anchorName);
    expect(panel.dataset.placement).toBe("top-end");
    await keyPhase("{Escape}", "hidden");
    if (lazy === "while-open") {
      expect(panel.querySelector("[role=menuitem]")).toBeNull();
      setLabel("Updated");
      flush();
    }
    expect(view.handle.open()).toBe(true);
    await phase(surface(), "open");
    const current = item(lazy === true ? "Ready" : "Updated");
    expect(document.activeElement).toBe(current);
    if (lazy === true) {
      expect(current).toBe(ready);
      expect(childrenReads).toBe(1);
    }
    expect(button.style.getPropertyValue("anchor-name")).toBe(anchorName);
    view.unmount();
    expect(button.style.getPropertyValue("anchor-name")).toBe("");
  });

  it.each([false, true])("refuses lazy admission without active effects (veto %s)", (veto) => {
    const view = mountMenu({
      lazy: true,
      items: veto ? [{ id: "ready", label: "Ready" }] : [],
      onBeforeShow: (event) => {
        if (veto) {
          event.preventDefault();
        }
      },
    });
    trigger().focus();
    expect(view.handle.open()).toBe(false);
    expect(surface().matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(openSurfaces()).toEqual([]);
  });

  it("navigates from search through grouped compound rows and custom controls", async () => {
    const selected: string[] = [];
    let pins = 0;
    const [revision, setRevision] = createSignal(0);
    mountControls((controls) => {
      const agentItems = (): MenuEntry[] => [
        {
          id: "alpha",
          label: "Alpha",
          as: "div",
          content: (
            <>
              Alpha
              <button
                ref={controls.ref()}
                data-form-control
                tabindex="-1"
                onClick={(event) => {
                  event.stopPropagation();
                  pins += 1;
                }}
              >
                Pin Alpha
              </button>
            </>
          ),
        },
        { id: "beta", label: revision() ? "Beta refreshed" : "Beta" },
      ];
      return {
        get items(): MenuEntry[] {
          revision();
          return [
            {
              kind: "content",
              id: "search",
              content: <input ref={controls.ref()} data-search aria-label="Find agent" />,
            },
            {
              kind: "group",
              id: "agents",
              render: (renderItems) => <div class="agent-list">{renderItems(agentItems)}</div>,
              items: agentItems(),
            },
            {
              id: "footer",
              label: "Footer",
              render: (attributes) => <button {...attributes}>Footer</button>,
            },
          ];
        },
        onSelect: (entry) => selected.push(entry.id),
      };
    });
    await openMenu();
    const group = surface().querySelector(".agent-list");
    const footer = item("Footer");
    const alpha = surface().querySelector<HTMLElement>('[data-value="alpha"]')!;
    alpha.focus();
    setRevision(1);
    flush();
    expect(surface().querySelector(".agent-list")).toBe(group);
    expect(item("Footer")).toBe(footer);
    expect(document.activeElement).toBe(alpha);
    const search = surface().querySelector<HTMLInputElement>("input")!;
    search.focus();
    await press("{ArrowDown}", alpha);
    await tabTo(surface().querySelector("[data-form-control]")!);
    await tabTo(alpha, true);
    await press("{ArrowUp}", search);
    await press("{ArrowDown}{ArrowDown}", item("Beta refreshed"));
    await userEvent.click(surface().querySelector<HTMLButtonElement>("[data-form-control]")!);
    expect(pins).toBe(1);
    expect(selected).toEqual([]);
    await press("{ArrowDown}", item("Beta refreshed"));
    await keyPhase("{Enter}", "hidden");
    expect(selected).toEqual(["beta"]);
    await openMenu();
    item("Footer").focus();
    await keyPhase("{Enter}", "hidden");
    expect(selected).toEqual(["beta", "footer"]);
  });

  it("preserves native link gestures, disables unavailable links, and honors selection vetoes", async () => {
    const selected: string[] = [];
    let parentContextMenus = 0;
    render(() => (
      <aside
        onContextMenu={(event) => {
          parentContextMenus++;
          event.preventDefault();
        }}
      >
        <Menu
          id="people"
          label="People"
          items={[
            { id: "disabled", label: "Unavailable", href: "/new?agent=other", disabled: true },
            { id: "new", label: "New session", href: "/new?agent=main" },
          ]}
          onSelect={(entry, event) => {
            selected.push(entry.id);
            event.preventDefault();
          }}
        />
      </aside>
    ));
    flush();
    await openMenu();
    const link = surface().querySelector<HTMLAnchorElement>('a[data-value="new"]')!;
    const disabled = surface().querySelector<HTMLAnchorElement>('a[data-value="disabled"]')!;
    const mouse = (target: Element, type: string, init: MouseEventInit = {}) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    const prevented: boolean[] = [];
    const stopNavigation = (event: MouseEvent) => {
      prevented.push(event.defaultPrevented);
      // Observe the menu's decision before suppressing browser navigation in this test.
      event.preventDefault();
    };
    window.addEventListener("click", stopNavigation);
    window.addEventListener("auxclick", stopNavigation);
    try {
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
        mouse(link, "click", { [modifier]: true });
      }
      mouse(link, "click", { button: 1 });
      mouse(link, "auxclick", { button: 1 });
      expect(prevented).toEqual(Array(6).fill(false));
    } finally {
      window.removeEventListener("click", stopNavigation);
      window.removeEventListener("auxclick", stopNavigation);
    }
    expect(mouse(link, "contextmenu", { button: 2 }).defaultPrevented).toBe(false);
    expect(parentContextMenus).toBe(0);
    expect(selected).toEqual([]);
    expect(surface().matches(":popover-open")).toBe(true);
    expect(mouse(trigger(), "contextmenu").defaultPrevented).toBe(true);
    expect(parentContextMenus).toBe(1);
    expect(disabled.hasAttribute("href")).toBe(false);
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.tabIndex).toBe(-1);
    disabled.click();
    expect(selected).toEqual([]);
    await userEvent.click(link);
    expect(selected).toEqual(["new"]);
    expect(surface().matches(":popover-open")).toBe(true);
    link.focus();
    await userEvent.keyboard("{Enter}");
    expect(selected).toEqual(["new", "new"]);
    expect(surface().matches(":popover-open")).toBe(true);
  });

  it("owns Tab dismissal with caller-selected focus destinations", async () => {
    const credential = document.createElement("input");
    credential.value = "synthetic-key";
    let veto = true;
    const view = mountMenu({
      id: "provider",
      label: "Provider",
      items: [{ id: "beta", label: "Beta" }],
      tabFocusTarget: (backward) => (backward ? trigger("provider") : credential),
      onBeforeHide: (event) => {
        if (veto) {
          event.preventDefault();
        }
      },
    });
    view.container.append(credential);
    await openMenu("provider");
    await userEvent.tab();
    expect(surface("provider").matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(item("Beta", "provider"));
    veto = false;
    await userEvent.tab();
    await phase(surface("provider"), "hidden");
    expect(document.activeElement).toBe(credential);
    expect(credential.value).toBe("synthetic-key");
    await openMenu("provider");
    await userEvent.tab({ shift: true });
    await phase(surface("provider"), "hidden");
    expect(document.activeElement).toBe(trigger("provider"));
  });

  it("reopens at the selected item with a custom root trigger and preserves navigation", async () => {
    const [selected, setSelected] = createSignal("alpha");
    const choices = ["Alpha", "Beta", "Gamma"].map((label) => ({ id: label.toLowerCase(), label }));
    const view = mountMenu({
      get triggerAttributes(): MenuProps["triggerAttributes"] {
        return { id: "provider-trigger", "data-value": selected(), "aria-busy": "false" };
      },
      get items() {
        return choices.map<MenuItem>((choice) => ({
          id: choice.id,
          label: choice.label,
          type: "radio",
          checked: choice.id === selected(),
          attributes: { "data-initial-focus": choice.id === selected() ? "" : undefined },
        }));
      },
      onSelect: (entry) => setSelected(entry.id),
    });
    const button = view.getByRole("button", { name: "People" });
    expect(button.id).toBe("provider-trigger");
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(surface().id);
    expect(surface().getAttribute("aria-labelledby")).toBe("provider-trigger");
    button.focus();
    await keyPhase("{Enter}", "open");
    expect(document.activeElement).toBe(item("Alpha"));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    flush();
    await phase(surface(), "hidden");
    expect(button.getAttribute("data-value")).toBe("beta");
    expect(document.activeElement).toBe(button);
    await keyPhase("{Enter}", "open");
    expect(item("Beta").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(item("Beta"));
    await press("{Home}", item("Alpha"));
    await press("{End}", item("Gamma"));
    await keyPhase("{Escape}", "hidden");
    expect(document.activeElement).toBe(button);
    await keyPhase("{ArrowUp}", "open");
    expect(document.activeElement).toBe(item("Gamma"));
    await press("{Home}g", item("Gamma"));
    expect(item("Gamma").tabIndex).toBe(0);
    expect(surface().hasAttribute("aria-activedescendant")).toBe(false);
    await keyPhase("{Enter}", "hidden");
    expect(button.getAttribute("data-value")).toBe("gamma");
    await keyPhase("{ArrowUp}", "open");
    await keyPhase("{Escape}", "hidden");
    expect(document.activeElement).toBe(button);
  });

  it.each(["ArrowDown", "ArrowUp"])(
    "skips disabled submenu triggers when opened with %s",
    async (key) => {
      const children = [{ id: "child", label: "Child" }];
      mountMenu({
        items: [
          submenu("first", "Unavailable first", children, true),
          { id: "enabled", label: "Enabled" },
          submenu("last", "Unavailable last", children, true),
        ],
      });
      trigger().focus();
      await keyPhase(`{${key}}`, "open");
      expect(document.activeElement).toBe(item("Enabled"));
      await press("{ArrowDown}", item("Enabled"));
      expect(trigger("people-first").getAttribute("aria-disabled")).toBe("true");
    },
  );

  it.each(["ltr", "rtl"] as const)("preserves sibling → Back → Down in %s", async (dir) => {
    mountMenu({ dir });
    await openMenu();
    expect(trigger("people-assign").dataset.value).toBe("assign");
    expect(trigger("people-move").dataset.value).toBe("move");
    await openMenu("people-assign");
    trigger("people-move").focus();
    await userEvent.keyboard(dir === "ltr" ? "{ArrowRight}" : "{ArrowLeft}");
    await phase(surface("people-move"), "open");
    await phase(surface("people-assign"), "hidden");
    expect(document.activeElement).toBe(item("Engineering", "people-move"));
    await press(dir === "ltr" ? "{ArrowLeft}" : "{ArrowRight}", trigger("people-move"));
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(item("Archive"));
    await press("{Home}", trigger("people-assign"));
    await phase(surface("people-move"), "hidden");
    expect(openSurfaces()).toEqual([surface()]);
  });

  it.each(["before first open", "before reopen"] as const)(
    "keeps live RTL keyboard direction when changed %s",
    async (when) => {
      const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr");
      mountMenu({
        get dir() {
          return direction();
        },
      });
      if (when === "before reopen") {
        await openMenu();
        trigger("people-assign").focus();
        await keyPhase("{ArrowRight}", "open", "people-assign");
        await keyPhase("{ArrowLeft}{Escape}", "hidden");
      }
      setDirection("rtl");
      flush();
      await openMenu();
      trigger("people-assign").focus();
      await keyPhase("{ArrowLeft}", "open", "people-assign");
      expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
      await keyPhase("{ArrowRight}", "hidden", "people-assign");
      expect(document.activeElement).toBe(trigger("people-assign"));
      await press("{ArrowDown}", trigger("people-move"));
    },
  );

  it("clears search before closing the deepest branch and restores each trigger", async () => {
    mountControls((controls) => ({
      items: [
        {
          id: "search",
          label: "Find person",
          children: [{ id: "ada", label: "Ada" }],
          content: (
            <input
              ref={controls.ref()}
              aria-label="Search people"
              data-search=""
              data-initial-focus=""
            />
          ),
        },
      ],
    }));
    await openMenu();
    await openMenu("people-search");
    const search = surface("people-search").querySelector("input")!;
    expect(document.activeElement).toBe(search);
    await userEvent.fill(search, "Grace");
    await userEvent.keyboard("{Escape}");
    expect(search.value).toBe("");
    expect(surface("people-search").matches(":popover-open")).toBe(true);
    await keyPhase("{Escape}", "hidden", "people-search");
    expect(surface().matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(trigger("people-search"));
    await keyPhase("{Escape}", "hidden");
    expect(document.activeElement).toBe(trigger());
  });

  it("traverses rows and eligible controls while preserving editing and native Tab exit", async () => {
    const view = mountControls((controls) => ({
      items: [
        { id: "before", label: "Before settings" },
        {
          kind: "content",
          id: "settings",
          content: (
            <>
              <input ref={controls.ref()} aria-label="Filter settings" data-search="" />
              <button ref={controls.ref()} data-form-control="">
                Default
              </button>
              <button ref={controls.ref()} data-form-control="" disabled>
                Disabled
              </button>
              <button ref={controls.ref()} data-form-control="" aria-disabled="true">
                Unavailable
              </button>
              <input
                ref={controls.ref()}
                aria-label="Hidden attribute"
                data-form-control=""
                hidden
              />
              <input ref={controls.ref()} type="hidden" data-form-control="" />
              <span style={{ visibility: "hidden" }}>
                <input ref={controls.ref()} aria-label="Invisible" data-form-control="" />
              </span>
              <span ref={controls.ref()} data-form-control="">
                Not focusable
              </span>
              <button ref={controls.ref()} data-form-control="" tabindex={-1}>
                Not sequential
              </button>
              <div inert>
                <input ref={controls.ref()} aria-label="Inert control" data-form-control="" />
              </div>
              <button ref={controls.ref()} data-form-control="">
                Coral
              </button>
              <input ref={controls.ref()} aria-label="Custom icon" data-form-control="" />
            </>
          ),
        },
        { id: "after", label: "After settings" },
      ],
    }));
    await openMenu();
    const first = view.getByRole("button", { name: "Default" });
    const second = view.getByRole("button", { name: "Coral" });
    const input = view.getByRole("textbox", { name: "Custom icon" }) as HTMLInputElement;
    const search = view.getByRole("textbox", { name: "Filter settings" });
    item("Before settings").focus();
    await tabTo(search);
    await tabTo(first);
    await tabTo(second);
    await tabTo(first, true);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(input);
    await tabTo(item("After settings"));
    await tabTo(input, true);
    await tabTo(second, true);
    await tabTo(first, true);
    await tabTo(search, true);
    await tabTo(item("Before settings"), true);
    input.focus();
    await userEvent.fill(input, "abc");
    await userEvent.keyboard("{ArrowLeft}X");
    expect(input.value).toBe("abXc");
    await keyPhase("{Escape}", "hidden");
    await openMenu();
    expect(view.getByRole("textbox", { name: "Custom icon" })).toBe(input);
    expect(input.value).toBe("abXc");
    input.focus();
    await tabTo(item("After settings"));
    await userEvent.tab();
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
  });

  it("keeps Tab in the current menu when a descendant menu has visible controls", async () => {
    let veto = true;
    const view = mountControls((controls) => ({
      items: [],
      children: (
        <>
          <input ref={controls.ref()} aria-label="First control" data-form-control="" />
          <Menu
            id="nested-controls"
            label="Nested controls"
            items={[]}
            controls={controls}
            onBeforeHide={(event) => {
              if (veto) {
                event.preventDefault();
              }
            }}
          >
            <input ref={controls.ref()} aria-label="Descendant control" data-form-control="" />
          </Menu>
          <input ref={controls.ref()} aria-label="Last control" data-form-control="" />
        </>
      ),
    }));
    await openMenu();
    await openMenu("nested-controls");
    const first = view.getByRole("textbox", { name: "First control" });
    const last = view.getByRole("textbox", { name: "Last control" });
    first.focus();
    expect(surface("nested-controls").matches(":popover-open")).toBe(true);
    await tabTo(last);
    await tabTo(first, true);
    veto = false;
    last.focus();
    await userEvent.tab();
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
  });

  it("publishes cancelable selection and renders owner-controlled checkbox/radio state", async () => {
    const [entries, setEntries] = createSignal<readonly MenuItem[]>([
      { id: "notify", label: "Notify", type: "checkbox", checked: false, closeOnSelect: false },
      { id: "default", label: "Default", type: "radio", checked: true },
      { id: "restricted", label: "Restricted", type: "radio", checked: false },
    ]);
    let veto = true;
    mountMenu({
      get items() {
        return entries();
      },
      onSelect: (entry, event) => {
        if (veto) {
          event.preventDefault();
          return;
        }
        setEntries((current) =>
          current.map((value) => ({
            ...value,
            checked:
              value.type === "radio" && entry.type === "radio"
                ? value.id === entry.id
                : value.id === entry.id
                  ? !value.checked
                  : value.checked,
          })),
        );
      },
    });
    await openMenu();
    await userEvent.click(item("Restricted"));
    expect(item("Restricted").getAttribute("aria-checked")).toBe("false");
    expect(surface().matches(":popover-open")).toBe(true);
    veto = false;
    await userEvent.click(item("Notify"));
    flush();
    expect(item("Notify").getAttribute("aria-checked")).toBe("true");
    expect(surface().matches(":popover-open")).toBe(true);
    await userEvent.click(item("Restricted"));
    flush();
    await phase(surface(), "hidden");
    await openMenu();
    expect(item("Restricted").getAttribute("aria-checked")).toBe("true");
    expect(item("Default").getAttribute("aria-checked")).toBe("false");
  });
});

function mountColdMenu(options: Partial<MenuProps> = {}) {
  const view = mountMenu({
    lazy: true,
    items: ["Alpha", "Beta", "Gamma"].map((label) => ({ id: label.toLowerCase(), label })),
    ...options,
  });
  return { view, handle: view.handle, button: trigger(), panel: surface() };
}

function coldKey(target: Element, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it("defers cold button pointer focus until click without suppressing context menus", () => {
  const { handle, button } = mountColdMenu();
  const down = (mouseButton: number) => {
    const event = new PointerEvent("pointerdown", {
      button: mouseButton,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event;
  };
  expect(down(0).defaultPrevented).toBe(true);
  expect(handle.overlay.open).toBe(false);
  expect(down(2).defaultPrevented).toBe(false);
  button.click();
  expect(handle.overlay.open).toBe(true);
});

it("queues retained-focus input navigation outside the listbox during first load", async () => {
  const selections: string[][] = [];
  const view = render(() => (
    <MultiSelect
      accessibleLabel="Choices"
      options={[
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ]}
      onChange={(values) => selections.push(values)}
    />
  ));
  flush();
  const input = view.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const panel = view.container.querySelector('[role="listbox"]')!;
  input.focus();
  coldKey(input, "ArrowDown");
  flush();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(panel.contains(input)).toBe(false);
  expect(coldKey(input, "ArrowDown").defaultPrevented).toBe(true);
  expect(coldKey(input, "Enter").defaultPrevented).toBe(true);
  await expect.poll(() => selections).toEqual([["beta"]]);
  expect(document.activeElement).toBe(input);
});

it.each([
  { keys: ["ArrowDown", "ArrowDown"], focused: "gamma", selected: [] },
  { keys: ["ArrowDown", "Enter"], focused: null, selected: ["beta"] },
  { keys: ["End", "Enter"], focused: null, selected: ["gamma"] },
])("replays queued $keys in navigation order", async ({ keys, focused, selected }) => {
  const selections: string[] = [];
  const { handle, panel } = mountColdMenu({ onSelect: (entry) => selections.push(entry.id) });
  expect(handle.open()).toBe(true);
  const first = panel.querySelector<HTMLElement>('[data-value="alpha"]')!;
  for (const value of keys) {
    coldKey(first, value);
  }
  if (focused) {
    await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe(focused);
  } else {
    await expect.poll(() => selections).toEqual(selected);
  }
});

it.each(["Enter", " "])(
  "commits a focused cold leaf with %j before immediate overlay close",
  (value) => {
    const selections: string[] = [];
    const { handle, panel } = mountColdMenu({ onSelect: (entry) => selections.push(entry.id) });
    expect(handle.open()).toBe(true);
    const target = panel.querySelector<HTMLElement>('[data-value="beta"]')!;
    target.focus();
    expect(coldKey(target, value).defaultPrevented).toBe(true);
    handle.close();
    expect(selections).toEqual(["beta"]);
  },
);

it("continues from the entry row when focus returns to the button during first load", async () => {
  const { handle, button, panel } = mountColdMenu();
  expect(handle.open()).toBe(true);
  expect(document.activeElement).toBe(panel.querySelector('[data-value="alpha"]'));
  button.focus();
  expect(coldKey(button, " ").defaultPrevented).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("beta");
});

it("leaves native control activation keys unhandled during first load", () => {
  const { handle, panel } = mountColdMenu({
    children: (
      <>
        <button data-form-control>Native button</button>
        <a href="#native-control" data-form-control>
          Native link
        </a>
        <input data-form-control />
        <textarea data-form-control />
        <select data-form-control>
          <option>Native option</option>
        </select>
      </>
    ),
  });
  expect(handle.open()).toBe(true);
  for (const control of panel.querySelectorAll<HTMLElement>("[data-form-control]")) {
    control.focus();
    expect(coldKey(control, "Enter").defaultPrevented).toBe(false);
    expect(coldKey(control, " ").defaultPrevented).toBe(false);
  }
});

it("bubbles parent navigation from an open submenu button during first load", async () => {
  const { handle } = mountColdMenu({
    items: [
      { id: "group", label: "Group", children: [{ id: "nested", label: "Nested" }] },
      { id: "next", label: "Next" },
    ],
  });
  expect(handle.open()).toBe(true);
  flush();
  const child = [...handle.overlay.children][0]!;
  expect(child.request(true, "none")).toBe(true);
  child.trigger!.focus();
  coldKey(child.trigger!, "ArrowDown");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("next");
});

it("leaves Escape to the open child when focus stays on its cold parent button", () => {
  let help!: PopoverHandle;
  const [showHelp, setShowHelp] = createSignal(false);
  const { handle } = mountColdMenu({
    children: (
      <Show when={showHelp()}>
        <Popover id="cold-help" label="Help" ref={(value) => (help = value)}>
          Menu help
        </Popover>
      </Show>
    ),
  });
  expect(handle.open()).toBe(true);
  setShowHelp(true);
  flush();
  expect(help.overlay.parent).toBe(handle.overlay);
  expect(help.show()).toBe(true);
  help.overlay.trigger!.focus();

  // No await: the navigation import cannot settle before the first Escape.
  expect(coldKey(help.overlay.trigger!, "Escape").defaultPrevented).toBe(true);
  expect(help.overlay.open).toBe(false);
  expect(handle.overlay.open).toBe(true);
  expect(document.activeElement).toBe(help.overlay.trigger);

  coldKey(help.overlay.trigger!, "Escape");
  expect(handle.overlay.open).toBe(false);
});

it("admits and focuses synchronously, retires old keys, and replays input after first load", async () => {
  const { handle, button, panel } = mountColdMenu();
  expect(handle.open()).toBe(true);
  const first = panel.querySelector<HTMLElement>('[data-value="alpha"]')!;
  expect(document.activeElement).toBe(first);
  coldKey(first, "g");
  expect(handle.close()).toBe(true);
  expect(handle.open()).toBe(true);
  coldKey(first, "ArrowDown");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("beta");
  coldKey(document.activeElement!, "g");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("gamma");
  expect(handle.close()).toBe(true);
  coldKey(button, "ArrowUp");
  await expect.poll(() => handle.overlay.open).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("gamma");
  expect(panel.querySelector('[data-value="alpha"]')).toBe(first);
});

it("does not reopen a disposed owner after loading", async () => {
  const { view, handle } = mountColdMenu();
  expect(handle.open()).toBe(true);
  view.unmount();
  await Promise.resolve();
  expect(handle.overlay.open).toBe(false);
  expect(document.querySelector(":popover-open")).toBeNull();
});
