import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { expect } from "vitest";
import { userEvent } from "vitest/browser";
import { mountMenu, phase, surface } from "../../test-helpers/solid-menu.tsx";
import { createMenuControls, type MenuControls, type MenuEntry, type MenuProps } from "./menu.tsx";

type DataAttributes = { [key: `data-${string}`]: string };
type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & DataAttributes;
export function update(change: () => void) {
  change();
  flush();
}
export async function keyFocus(
  keys: string,
  target: Element | null,
  active = () => document.activeElement,
) {
  await userEvent.keyboard(keys);
  expect(active()).toBe(target);
}
export async function tabFocus(target: Element | null, backward = false) {
  await userEvent.tab({ shift: backward });
  expect(document.activeElement).toBe(target);
}
export async function keyPhase(keys: string, value: "open" | "hidden", id = "people") {
  await userEvent.keyboard(keys);
  await phase(surface(id), value);
}
export function mountControls(build: (controls: MenuControls) => Partial<MenuProps>) {
  return mountMenu(() => {
    const controls = createMenuControls();
    return Object.assign(build(controls), { controls });
  });
}
export function controlInput(controls: MenuControls, label: string, props: InputProps = {}) {
  return <input ref={controls.ref()} aria-label={label} {...props} />;
}
export function submenu(id: string, label: string, items: readonly MenuEntry[], disabled = false) {
  return { id, label, children: items, disabled };
}
