import { cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import {
  item,
  mountMenu,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import {
  controlInput,
  keyFocus,
  keyPhase,
  mountControls,
  submenu,
  update,
} from "./menu-contract.test-support.tsx";

afterEach(cleanup);

const branch = (disabled = false) => [
  submenu("more", "More", [
    submenu("inner", "Inner", [{ id: "deep", label: "Deep action" }], disabled),
  ]),
];
async function openBranch() {
  await openMenu();
  await openMenu("people-more");
  await openMenu("people-more-inner");
}

it("keeps native autofocus on an input inside grouped content", async () => {
  mountControls((controls) => ({
    children: <div>{controlInput(controls, "Filter actions", { autofocus: true })}</div>,
  }));
  await openMenu();
  expect(document.activeElement).toBe(surface().querySelector("input"));
});

it.each(["item", "input"] as const)(
  "preserves newer %s focus across opening completion",
  async (target) => {
    const view = mountControls((controls) => ({
      children: controlInput(controls, "Filter actions"),
    }));
    expect(view.handle.open()).toBe(true);
    const focused = target === "item" ? item("Archive") : surface().querySelector("input")!;
    focused.focus();
    await phase(surface(), "open");
    expect(document.activeElement).toBe(focused);
    expect(openSurfaces()).toEqual([surface()]);
  },
);

it("preserves keyboard selection while the root is still opening", async () => {
  const selected: string[] = [];
  const view = mountMenu({ onSelect: (entry) => selected.push(entry.id) });
  expect(view.handle.open()).toBe(true);
  item("Archive").focus();
  await keyPhase("{Enter}", "hidden");
  expect(selected).toEqual(["archive"]);
  expect(document.activeElement).toBe(trigger());
});

it("keeps descendants when the same ancestor receives another open request", async () => {
  const view = mountMenu({ items: branch() });
  await openBranch();
  const more = [...view.handle.overlay.children].find((child) => child.id === "people-more")!;
  expect(more.request(true)).toBe(true);
  expect(more.request(true)).toBe(true);
  expect(openSurfaces()).toHaveLength(3);
  expect(document.activeElement).toBe(item("Deep action", "people-more-inner"));
  await keyFocus("{ArrowLeft}", trigger("people-more-inner"));
  await keyFocus("{ArrowLeft}", trigger("people-more"));
});

it("retires disabled descendants on root close and permits a fresh branch opening", async () => {
  const [disabled, setDisabled] = createSignal(false);
  const view = mountMenu({
    get items() {
      return branch(disabled());
    },
  });
  await openBranch();
  update(() => setDisabled(true));
  expect(view.handle.close()).toBe(true);
  await phase(surface(), "hidden");
  expect(openSurfaces()).toEqual([]);
  expect(surface("people-more").inert).toBe(true);
  expect(surface("people-more-inner").inert).toBe(true);
  update(() => setDisabled(false));
  await openBranch();
  expect(document.activeElement).toBe(item("Deep action", "people-more-inner"));
});
