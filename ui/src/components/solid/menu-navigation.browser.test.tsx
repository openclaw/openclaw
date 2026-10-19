import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  item,
  mountMenu,
  navigationItems,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import {
  createMenuControls,
  Menu,
  type MenuEntry,
  type MenuItem,
  type MenuProps,
} from "./menu.tsx";

afterEach(cleanup);

describe("Solid menu navigation", () => {
  it("releases transient rows on close and restores current rows with keyboard focus", async () => {
    const [label, setLabel] = createSignal("First");
    const view = mountMenu({
      lazy: "while-open",
      get items() {
        return [{ id: "current", label: label() }];
      },
    });
    expect(surface().querySelector("[role=menuitem]")).toBeNull();
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}");
    await phase(surface(), "open");
    expect(document.activeElement).toBe(item("First"));
    expect(document.querySelectorAll(":popover-open")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    await phase(surface(), "hidden");
    expect(surface().querySelector("[role=menuitem]")).toBeNull();
    setLabel("Second");
    flush();
    expect(view.handle.open()).toBe(true);
    expect(document.activeElement).toBe(item("Second"));
  });

  it("materializes lazy content at first keyboard admission and retains it when reopened", async () => {
    let itemReads = 0;
    let childrenReads = 0;
    const view = mountMenu({
      lazy: true,
      get items() {
        itemReads += 1;
        return [{ id: "ready", label: "Ready" }];
      },
      get children() {
        childrenReads += 1;
        return <span>Lazy heading</span>;
      },
    });
    expect(itemReads).toBe(0);
    expect(childrenReads).toBe(0);
    trigger().focus();
    await userEvent.keyboard("{ArrowDown}");
    await phase(surface(), "open");
    const ready = item("Ready");
    expect(document.activeElement).toBe(ready);
    expect(childrenReads).toBe(1);
    await userEvent.keyboard("{Escape}");
    await phase(surface(), "hidden");
    expect(view.handle.open()).toBe(true);
    await phase(surface(), "open");
    expect(item("Ready")).toBe(ready);
    expect(childrenReads).toBe(1);
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
    mountMenu(() => {
      const controls = createMenuControls();
      return {
        controls,
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
              class: "agent-list",
              items: [
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
                { id: "beta", label: "Beta" },
              ],
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
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(alpha);
    await userEvent.tab();
    expect(document.activeElement).toBe(surface().querySelector("[data-form-control]"));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(alpha);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(search);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(item("Beta"));
    await userEvent.click(surface().querySelector<HTMLButtonElement>("[data-form-control]")!);
    expect(pins).toBe(1);
    expect(selected).toEqual([]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Beta"));
    await userEvent.keyboard("{Enter}");
    await phase(surface(), "hidden");
    expect(selected).toEqual(["beta"]);
    await openMenu();
    item("Footer").focus();
    await userEvent.keyboard("{Enter}");
    await phase(surface(), "hidden");
    expect(selected).toEqual(["beta", "footer"]);
  });

  it("preserves modified, middle, and context-menu link gestures without selecting", async () => {
    const selected: string[] = [];
    let parentContextMenus = 0;
    render(() => (
      <aside
        onContextMenu={(event) => {
          parentContextMenus += 1;
          event.preventDefault();
        }}
      >
        <Menu
          id="people"
          label="People"
          items={[{ id: "new", label: "New session", href: "/new?agent=main" }]}
          onSelect={(entry) => selected.push(entry.id)}
        />
      </aside>
    ));
    flush();
    await openMenu();
    const link = surface().querySelector<HTMLAnchorElement>("a")!;
    const prevented: boolean[] = [];
    const stopNavigation = (event: MouseEvent) => {
      prevented.push(event.defaultPrevented);
      // Observe the menu's decision before suppressing browser navigation in this test.
      event.preventDefault();
    };
    window.addEventListener("click", stopNavigation);
    window.addEventListener("auxclick", stopNavigation);
    try {
      for (const modifiers of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        link.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }),
        );
      }
      link.dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
      );
      expect(prevented).toEqual(Array(6).fill(false));
    } finally {
      window.removeEventListener("click", stopNavigation);
      window.removeEventListener("auxclick", stopNavigation);
    }
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    link.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(parentContextMenus).toBe(0);
    expect(selected).toEqual([]);
    expect(surface().matches(":popover-open")).toBe(true);
    const triggerContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    trigger().dispatchEvent(triggerContextMenu);
    expect(triggerContextMenu.defaultPrevented).toBe(true);
    expect(parentContextMenus).toBe(1);
  });

  it("keeps disabled links inert and honors link selection vetoes", async () => {
    const selected: string[] = [];
    mountMenu({
      items: [
        { id: "disabled", label: "Unavailable", href: "/new?agent=other", disabled: true },
        { id: "new", label: "New session", href: "/new?agent=main" },
      ],
      onSelect: (entry, event) => {
        selected.push(entry.id);
        event.preventDefault();
      },
    });
    await openMenu();
    const disabled = surface().querySelector<HTMLAnchorElement>('a[data-value="disabled"]')!;
    const link = surface().querySelector<HTMLAnchorElement>('a[data-value="new"]')!;
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
    let credential!: HTMLInputElement;
    let veto = true;
    render(() => (
      <>
        <button>Before picker</button>
        <Menu
          id="provider"
          label="Provider"
          items={[{ id: "beta", label: "Beta" }]}
          tabFocusTarget={(backward) => (backward ? trigger("provider") : credential)}
          onBeforeHide={(event) => {
            if (veto) {
              event.preventDefault();
            }
          }}
        />
        <input ref={(node) => (credential = node)} aria-label="Credential" />
      </>
    ));
    flush();
    credential.value = "synthetic-key";
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
    const choices = [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
      { id: "gamma", label: "Gamma" },
    ];
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
    await userEvent.keyboard("{Enter}");
    await phase(surface(), "open");
    expect(document.activeElement).toBe(item("Alpha"));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    flush();
    await phase(surface(), "hidden");
    expect(button.getAttribute("data-value")).toBe("beta");
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    await phase(surface(), "open");
    expect(item("Beta").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(item("Beta"));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(item("Alpha"));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(item("Gamma"));
    await userEvent.keyboard("{Escape}");
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{ArrowUp}");
    await phase(surface(), "open");
    expect(document.activeElement).toBe(item("Gamma"));
    await userEvent.keyboard("{Escape}");
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(button);
  });

  it.each(["ArrowDown", "ArrowUp"])(
    "skips disabled submenu triggers when opened with %s",
    async (key) => {
      mountMenu({
        items: [
          {
            id: "first",
            label: "Unavailable first",
            disabled: true,
            children: [{ id: "one", label: "One" }],
          },
          { id: "enabled", label: "Enabled" },
          {
            id: "last",
            label: "Unavailable last",
            disabled: true,
            children: [{ id: "two", label: "Two" }],
          },
        ],
      });
      trigger().focus();
      await userEvent.keyboard(`{${key}}`);
      await phase(surface(), "open");
      expect(document.activeElement).toBe(item("Enabled"));
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(item("Enabled"));
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
    expect(surface("people-assign").matches(":popover-open")).toBe(false);
    expect(document.activeElement).toBe(item("Engineering", "people-move"));
    await userEvent.keyboard(dir === "ltr" ? "{ArrowLeft}" : "{ArrowRight}");
    expect(document.activeElement).toBe(trigger("people-move"));
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(item("Archive"));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(trigger("people-assign"));
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
        await userEvent.keyboard("{ArrowRight}");
        await phase(surface("people-assign"), "open");
        await userEvent.keyboard("{ArrowLeft}{Escape}");
        await phase(surface(), "hidden");
      }
      setDirection("rtl");
      flush();
      await openMenu();
      trigger("people-assign").focus();
      await userEvent.keyboard("{ArrowLeft}");
      await phase(surface("people-assign"), "open");
      expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
      await userEvent.keyboard("{ArrowRight}");
      await phase(surface("people-assign"), "hidden");
      expect(document.activeElement).toBe(trigger("people-assign"));
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(trigger("people-move"));
    },
  );

  it.each([undefined, "checkbox", "radio"] as const)(
    "uses real item focus, skips disabled items, and activates typeahead results (%s)",
    async (type) => {
      const selected: string[] = [];
      mountMenu({
        items: [
          ...navigationItems.slice(0, -1),
          { id: "configured-choice", label: "Archive", type },
        ],
        onSelect: (entry) => selected.push(entry.id),
      });
      await openMenu();
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(item("Archive"));
      await userEvent.keyboard("{ArrowUp}");
      expect(document.activeElement).toBe(trigger("people-move"));
      await userEvent.keyboard("{Home}a");
      expect(document.activeElement).toBe(item("Archive"));
      expect(surface().hasAttribute("aria-activedescendant")).toBe(false);
      expect(item("Archive").tabIndex).toBe(0);
      await userEvent.keyboard("{Enter}");
      await phase(surface(), "hidden");
      expect(selected).toEqual(["configured-choice"]);
      expect(document.activeElement).toBe(trigger());
    },
  );

  it("clears search before closing the deepest branch and restores each trigger", async () => {
    mountMenu(() => {
      const controls = createMenuControls();
      return {
        controls,
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
      };
    });
    await openMenu();
    await openMenu("people-search");
    const search = surface("people-search").querySelector("input")!;
    expect(document.activeElement).toBe(search);
    await userEvent.fill(search, "Grace");
    await userEvent.keyboard("{Escape}");
    expect(search.value).toBe("");
    expect(surface("people-search").matches(":popover-open")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await phase(surface("people-search"), "hidden");
    expect(surface().matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(trigger("people-search"));
    await userEvent.keyboard("{Escape}");
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(trigger());
  });

  it("skips ineligible controls while preserving editing and native Tab exit", async () => {
    const view = mountMenu(() => {
      const controls = createMenuControls();
      return {
        controls,
        items: [],
        children: (
          <>
            <button ref={controls.ref()} data-form-control="">
              Default
            </button>
            <button ref={controls.ref()} data-form-control="" disabled>
              Disabled
            </button>
            <button ref={controls.ref()} data-form-control="" aria-disabled="true">
              Unavailable
            </button>
            <input ref={controls.ref()} aria-label="Hidden attribute" data-form-control="" hidden />
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
      };
    });
    await openMenu();
    const first = view.getByRole("button", { name: "Default" });
    const second = view.getByRole("button", { name: "Coral" });
    const input = view.getByRole("textbox", { name: "Custom icon" }) as HTMLInputElement;
    first.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(second);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(first);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(input);
    await userEvent.fill(input, "abc");
    await userEvent.keyboard("{ArrowLeft}X");
    expect(input.value).toBe("abXc");
    await userEvent.keyboard("{Escape}");
    await phase(surface(), "hidden");
    await openMenu();
    expect(view.getByRole("textbox", { name: "Custom icon" })).toBe(input);
    expect(input.value).toBe("abXc");
    input.focus();
    await userEvent.tab();
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
  });

  it("moves between menu rows and embedded settings with Tab", async () => {
    const view = mountMenu(() => {
      const controls = createMenuControls();
      return {
        controls,
        items: [
          { id: "before", label: "Before settings" },
          {
            kind: "content",
            id: "settings",
            content: (
              <>
                <input ref={controls.ref()} aria-label="Filter settings" data-search="" />
                <button ref={controls.ref()} data-form-control="">
                  Send always
                </button>
                <button ref={controls.ref()} data-form-control="">
                  Receive always
                </button>
              </>
            ),
          },
          { id: "after", label: "After settings" },
        ],
      };
    });
    await openMenu();
    const before = item("Before settings");
    const after = item("After settings");
    const search = view.getByRole("textbox", { name: "Filter settings" });
    const send = view.getByRole("button", { name: "Send always" });
    const receive = view.getByRole("button", { name: "Receive always" });
    before.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(search);
    await userEvent.tab();
    expect(document.activeElement).toBe(send);
    await userEvent.tab();
    expect(document.activeElement).toBe(receive);
    await userEvent.tab();
    expect(document.activeElement).toBe(after);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(receive);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(send);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(search);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(before);
    expect(surface().matches(":popover-open")).toBe(true);
  });

  it("keeps Tab in the current menu when a descendant menu has visible controls", async () => {
    let veto = true;
    const view = render(() => {
      const controls = createMenuControls();
      return (
        <>
          <Menu id="people" label="People" items={[]} controls={controls}>
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
          </Menu>
          <button tabindex={0}>After menu</button>
        </>
      );
    });
    flush();
    await openMenu();
    await openMenu("nested-controls");
    const first = view.getByRole("textbox", { name: "First control" });
    const last = view.getByRole("textbox", { name: "Last control" });
    first.focus();
    expect(surface("nested-controls").matches(":popover-open")).toBe(true);
    await userEvent.tab();
    expect(document.activeElement).toBe(last);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(first);
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
