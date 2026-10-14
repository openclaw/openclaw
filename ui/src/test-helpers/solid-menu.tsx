import { render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { expect } from "vitest";
import { userEvent } from "vitest/browser";
import { Menu, type MenuHandle, type MenuItem, type MenuProps } from "../components/solid/menu.tsx";

export const navigationItems: readonly MenuItem[] = [
  {
    id: "assign",
    label: "Assign to",
    children: [
      { id: "ada", label: "Ada Rivera" },
      { id: "grace", label: "Grace Kim" },
    ],
  },
  {
    id: "move",
    label: "Move to group",
    children: [
      { id: "engineering", label: "Engineering" },
      { id: "design", label: "Design" },
    ],
  },
  { id: "disabled", label: "Unavailable", disabled: true },
  { id: "archive", label: "Archive" },
];

export function mountMenu(props: Partial<MenuProps> = {}) {
  let handle!: MenuHandle;
  const view = render(() => (
    <>
      <Menu
        id="people"
        label="People"
        items={navigationItems}
        {...props}
        ref={(value) => (handle = value)}
      />
      <button type="button">After menu</button>
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
  const element = document.getElementById(`${id}:content`);
  if (!element) {
    throw new Error(`Missing menu ${id}`);
  }
  return element;
}

export function trigger(id = "people"): HTMLButtonElement {
  const element = document.getElementById(`${id}:trigger`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing trigger ${id}`);
  }
  return element;
}

export function item(label: string, id = "people"): HTMLButtonElement {
  const element = [...surface(id).querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label &&
      candidate.closest('[role="menu"]') === surface(id),
  );
  if (!element) {
    throw new Error(`Missing ${label} in ${id}`);
  }
  return element;
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
