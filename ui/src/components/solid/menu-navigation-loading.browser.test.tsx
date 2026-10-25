import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, Show } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { MultiSelect } from "../multi-select.tsx";
import { Menu, type MenuHandle, type MenuProps } from "./menu.tsx";
import { Popover, type PopoverHandle } from "./popover.tsx";

afterEach(cleanup);

function mountMenu(options: Partial<MenuProps> = {}) {
  let handle!: MenuHandle;
  const view = render(() => (
    <Menu
      id="lazy-navigation"
      label="Actions"
      lazy
      ref={(value) => {
        handle = value;
      }}
      items={[
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
        { id: "gamma", label: "Gamma" },
      ]}
      {...options}
    />
  ));
  flush();
  const trigger = view.container.querySelector<HTMLButtonElement>(".oc-menu-trigger")!;
  const surface = view.container.querySelector<HTMLDivElement>(".oc-menu")!;
  return { view, handle, trigger, surface };
}
function key(target: Element, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it("defers cold trigger pointer focus until click without suppressing context menus", () => {
  const { handle, trigger } = mountMenu();
  const down = (button: number) => {
    const event = new PointerEvent("pointerdown", { button, bubbles: true, cancelable: true });
    trigger.dispatchEvent(event);
    return event;
  };
  expect(down(0).defaultPrevented).toBe(true);
  expect(handle.overlay.open).toBe(false);
  expect(down(2).defaultPrevented).toBe(false);
  trigger.click();
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
  const surface = view.container.querySelector('[role="listbox"]')!;
  input.focus();
  key(input, "ArrowDown");
  flush();
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(surface.contains(input)).toBe(false);
  expect(key(input, "ArrowDown").defaultPrevented).toBe(true);
  expect(key(input, "Enter").defaultPrevented).toBe(true);
  await expect.poll(() => selections).toEqual([["beta"]]);
  expect(document.activeElement).toBe(input);
});

it.each([
  { keys: ["ArrowDown", "ArrowDown"], focused: "gamma", selected: [] },
  { keys: ["ArrowDown", "Enter"], focused: null, selected: ["beta"] },
  { keys: ["End", "Enter"], focused: null, selected: ["gamma"] },
])("replays queued $keys in navigation order", async ({ keys, focused, selected }) => {
  const selections: string[] = [];
  const { handle, surface } = mountMenu({ onSelect: (entry) => selections.push(entry.id) });
  expect(handle.open()).toBe(true);
  const first = surface.querySelector<HTMLElement>('[data-value="alpha"]')!;
  for (const value of keys) {
    key(first, value);
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
    const { handle, surface } = mountMenu({ onSelect: (entry) => selections.push(entry.id) });
    expect(handle.open()).toBe(true);
    const target = surface.querySelector<HTMLElement>('[data-value="beta"]')!;
    target.focus();
    expect(key(target, value).defaultPrevented).toBe(true);
    handle.close();
    expect(selections).toEqual(["beta"]);
  },
);

it("continues from the entry row when focus returns to the trigger during first load", async () => {
  const { handle, trigger, surface } = mountMenu();
  expect(handle.open()).toBe(true);
  expect(document.activeElement).toBe(surface.querySelector('[data-value="alpha"]'));
  trigger.focus();
  expect(key(trigger, " ").defaultPrevented).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("beta");
});

it("leaves native control activation keys unhandled during first load", () => {
  const { handle, surface } = mountMenu({
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
  for (const control of surface.querySelectorAll<HTMLElement>("[data-form-control]")) {
    control.focus();
    expect(key(control, "Enter").defaultPrevented).toBe(false);
    expect(key(control, " ").defaultPrevented).toBe(false);
  }
});

it("bubbles parent navigation from an open submenu trigger during first load", async () => {
  const { handle } = mountMenu({
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
  key(child.trigger!, "ArrowDown");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("next");
});

it("leaves Escape to the open child when focus stays on its cold parent trigger", () => {
  let help!: PopoverHandle;
  const [showHelp, setShowHelp] = createSignal(false);
  const { handle } = mountMenu({
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
  expect(key(help.overlay.trigger!, "Escape").defaultPrevented).toBe(true);
  expect(help.overlay.open).toBe(false);
  expect(handle.overlay.open).toBe(true);
  expect(document.activeElement).toBe(help.overlay.trigger);

  key(help.overlay.trigger!, "Escape");
  expect(handle.overlay.open).toBe(false);
});

it("admits and focuses synchronously, retires old keys, and replays input after first load", async () => {
  const { handle, trigger, surface } = mountMenu();
  expect(handle.open()).toBe(true);
  const first = surface.querySelector<HTMLElement>('[data-value="alpha"]')!;
  expect(document.activeElement).toBe(first);
  key(first, "g");
  expect(handle.close()).toBe(true);
  expect(handle.open()).toBe(true);
  key(first, "ArrowDown");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("beta");
  key(document.activeElement!, "g");
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("gamma");
  expect(handle.close()).toBe(true);
  key(trigger, "ArrowUp");
  await expect.poll(() => handle.overlay.open).toBe(true);
  await expect.poll(() => document.activeElement?.getAttribute("data-value")).toBe("gamma");
  expect(surface.querySelector('[data-value="alpha"]')).toBe(first);
});

it("keeps rejected admission synchronous and does not reopen a disposed owner after loading", async () => {
  const vetoed = mountMenu({ onBeforeShow: (event) => event.preventDefault() });
  vetoed.trigger.focus();
  expect(vetoed.handle.open()).toBe(false);
  expect(document.activeElement).toBe(vetoed.trigger);
  vetoed.view.unmount();
  const { view, handle } = mountMenu();
  expect(handle.open()).toBe(true);
  view.unmount();
  await Promise.resolve();
  expect(handle.overlay.open).toBe(false);
  expect(document.querySelector(":popover-open")).toBeNull();
});
