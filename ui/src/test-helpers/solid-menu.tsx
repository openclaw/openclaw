import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { assert, expect } from "vitest";
import { userEvent } from "vitest/browser";
import { Menu, type MenuHandle, type MenuItem, type MenuProps } from "../components/solid/menu.tsx";

export const navigationItems: readonly MenuItem[] = [
  ...Object.entries({
    assign: ["Assign to", { ada: "Ada Rivera", grace: "Grace Kim" }],
    move: ["Move to group", { engineering: "Engineering", design: "Design" }],
  } as const).map(([id, [label, children]]) => ({
    id,
    label,
    children: Object.entries(children).map(([childId, childLabel]) => ({
      id: childId,
      label: childLabel,
    })),
  })),
  { id: "disabled", label: "Unavailable", disabled: true },
  { id: "archive", label: "Archive" },
];

export function mountMenu(props: Partial<MenuProps> | (() => Partial<MenuProps>) = {}) {
  let handle!: MenuHandle;
  const view = render(() => (
    <>
      <Menu
        id="people"
        label="People"
        items={navigationItems}
        {...(typeof props === "function" ? props() : props)}
        ref={(value) => (handle = value)}
      />
      <button type="button" tabindex={0}>
        After menu
      </button>
    </>
  ));
  flush();
  return {
    ...view,
    get handle() {
      return handle;
    },
  };
}

export function surface(id = "people"): HTMLElement {
  return expectDefined(document.getElementById(`${id}:content`), `menu ${id}`);
}

export function trigger(id = "people"): HTMLButtonElement {
  const element = document.getElementById(`${id}:trigger`);
  assert(element instanceof HTMLButtonElement, `Missing trigger ${id}`);
  return element;
}

export function item(label: string, id = "people"): HTMLButtonElement {
  return expectDefined(
    [...surface(id).querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label &&
        candidate.closest('[role="menu"]') === surface(id),
    ),
    `${label} in ${id}`,
  );
}

export async function phase(element: HTMLElement, value: "open" | "hidden"): Promise<void> {
  await expect
    .poll(() => element.matches(":popover-open"), { message: `${element.id} native visibility` })
    .toBe(value === "open");
  if (element.dataset.phase === value) {
    return;
  }
  return new Promise((resolve) => {
    element.addEventListener(
      value === "open" ? "overlay-after-show" : "overlay-after-hide",
      () => resolve(),
      { once: true },
    );
  });
}

export async function openMenu(id = "people") {
  await userEvent.click(trigger(id));
  await phase(surface(id), "open");
  expect(surface(id).matches(":popover-open")).toBe(true);
}

export function openSurfaces() {
  return [...document.querySelectorAll<HTMLElement>(".oc-menu:popover-open")];
}
