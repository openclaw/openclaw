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
  } as const).map(([branchId, [branchLabel, children]]) => ({
    id: branchId,
    label: branchLabel,
    children: Object.entries(children).map(([id, label]) => ({ id, label })),
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
    .poll(() => [element.matches(":popover-open"), element.dataset.phase], {
      message: `${element.id} native visibility and completed phase`,
    })
    .toEqual([value === "open", value]);
}

export async function openMenu(id = "people") {
  await userEvent.click(trigger(id));
  await phase(surface(id), "open");
}

export function openSurfaces() {
  return [...document.querySelectorAll<HTMLElement>(".oc-menu:popover-open")];
}
