import { cleanup } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { focusProgrammatically } from "../../lib/programmatic-focus.ts";
import { item, mountMenu, phase, surface, trigger } from "../../test-helpers/solid-menu.tsx";
import { keyFocus, keyPhase } from "./menu-contract.test-support.tsx";

afterEach(cleanup);

const rows = (view: ReturnType<typeof mountMenu>) => view.handle.itemElements();
const ringed = (element: Element | null) => element?.matches(":focus-visible");

it("moves focus without a ring when a pointer opens the menu", async () => {
  const view = mountMenu();
  await userEvent.click(trigger());
  await phase(surface(), "open");
  expect(document.activeElement).toBe(rows(view)[0]);
  expect(ringed(document.activeElement)).toBe(false);
});

it("keeps the trigger clear when a pointer selection returns focus", async () => {
  mountMenu();
  await userEvent.click(trigger());
  await phase(surface(), "open");
  await userEvent.click(item("Archive"));
  await phase(surface(), "hidden");
  expect(document.activeElement).toBe(trigger());
  expect(ringed(trigger())).toBe(false);
});

it("shows the ring as soon as the keyboard takes over a pointer-opened menu", async () => {
  const view = mountMenu();
  await userEvent.click(trigger());
  await phase(surface(), "open");
  await keyFocus("{ArrowDown}", rows(view)[1]!);
  expect(ringed(rows(view)[1]!)).toBe(true);
  await keyPhase("{Escape}", "hidden");
  expect(document.activeElement).toBe(trigger());
  expect(ringed(trigger())).toBe(true);
});

it("shows the ring on the current row when a key leaves focus in place", async () => {
  const view = mountMenu();
  await userEvent.click(trigger());
  await phase(surface(), "open");
  await keyFocus("{Home}", rows(view)[0]!);
  expect(ringed(rows(view)[0]!)).toBe(true);
  expect(view.handle.overlay.open).toBe(true);
});

it("shows the ring in a one-item menu on any key", async () => {
  const view = mountMenu({ items: [{ id: "only", label: "Only" }] });
  await userEvent.click(trigger());
  await phase(surface(), "open");
  const only = rows(view)[0]!;
  expect(ringed(only)).toBe(false);
  await keyFocus("{ArrowDown}", only);
  expect(ringed(only)).toBe(true);
  expect(view.handle.overlay.open).toBe(true);
});

it("ignores modifier keys until a real key is pressed", async () => {
  const view = mountMenu();
  await userEvent.click(trigger());
  await phase(surface(), "open");
  await userEvent.keyboard("{Shift}");
  expect(ringed(rows(view)[0]!)).toBe(false);
});

it.each(["{Enter}", " ", "{ArrowDown}"])("shows the ring when %j opens the menu", async (key) => {
  const view = mountMenu();
  trigger().focus();
  await keyPhase(key, "open");
  expect(document.activeElement).toBe(rows(view)[0]);
  expect(ringed(rows(view)[0]!)).toBe(true);
  await keyPhase("{Escape}", "hidden");
  expect(document.activeElement).toBe(trigger());
  expect(ringed(trigger())).toBe(true);
});

it("leaves text fields their native focus indication after a pointer", async () => {
  const input = document.createElement("input");
  document.body.append(input);
  await userEvent.click(document.body);
  focusProgrammatically(input);
  expect(ringed(input)).toBe(true);
  input.remove();
});

it("paints a programmatic ring only after keyboard input", async () => {
  const button = document.createElement("button");
  document.body.append(button);
  await userEvent.click(document.body);
  focusProgrammatically(button);
  expect(document.activeElement).toBe(button);
  expect(ringed(button)).toBe(false);
  button.blur();
  await userEvent.keyboard("x");
  focusProgrammatically(button);
  expect(ringed(button)).toBe(true);
  button.remove();
});
