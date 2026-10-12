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
import { Menu, type MenuItem } from "./menu.tsx";

afterEach(cleanup);

describe("Solid menu navigation", () => {
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

  it("opens at the last enabled item with ArrowUp and exits with native Tab", async () => {
    const view = mountMenu();
    trigger().focus();
    await userEvent.keyboard("{ArrowUp}");
    await phase(surface(), "open");
    expect(document.activeElement).toBe(item("Archive"));
    await userEvent.tab();
    await phase(surface(), "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
  });

  it("clears search before closing the deepest branch and restores each trigger", async () => {
    mountMenu({
      items: [
        {
          id: "search",
          label: "Find person",
          children: [{ id: "ada", label: "Ada" }],
          content: <input aria-label="Search people" data-search="" data-initial-focus="" />,
        },
      ],
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
    const view = mountMenu({
      children: (
        <>
          <button data-form-control="">Default</button>
          <button data-form-control="" disabled>
            Disabled
          </button>
          <button data-form-control="" aria-disabled="true">
            Unavailable
          </button>
          <input aria-label="Hidden attribute" data-form-control="" hidden />
          <input type="hidden" data-form-control="" />
          <span style={{ visibility: "hidden" }}>
            <input aria-label="Invisible" data-form-control="" />
          </span>
          <span data-form-control="">Not focusable</span>
          <button data-form-control="" tabindex={-1}>
            Not sequential
          </button>
          <div inert>
            <input aria-label="Inert control" data-form-control="" />
          </div>
          <button data-form-control="">Coral</button>
          <input aria-label="Custom icon" data-form-control="" />
        </>
      ),
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

  it("keeps Tab in the current menu when a descendant menu has visible controls", async () => {
    let veto = true;
    const view = render(() => (
      <>
        <Menu id="people" label="People" items={[]}>
          <input aria-label="First control" data-form-control="" />
          <Menu
            id="nested-controls"
            label="Nested controls"
            items={[]}
            onBeforeHide={(event) => {
              if (veto) {
                event.preventDefault();
              }
            }}
          >
            <input aria-label="Descendant control" data-form-control="" />
          </Menu>
          <input aria-label="Last control" data-form-control="" />
        </Menu>
        <button>After menu</button>
      </>
    ));
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
