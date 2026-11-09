/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createModalDialogTestFixture,
  getRenderedModalDialog,
} from "../test-helpers/modal-dialog.ts";
import { installPopoverPolyfill } from "../test-helpers/popover.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showPersonalSessionGroupDialog } from "./personal-session-group-dialog.tsx";

let fixture: ReturnType<typeof createModalDialogTestFixture>;
let restorePopover: () => void;
type DialogOptions = Parameters<typeof showPersonalSessionGroupDialog>[0];
const row = (key: string, label: string) => ({ key, label, pinnable: true });
const scopes = {
  personal: true,
  projects: [],
};
const options = {
  group: { label: "Dev", sessionKeys: ["a"] },
  known: [row("a", "Alpha")],
  scopes,
  load: async () => ({ sessions: [row("a", "Alpha")], hasMore: false }),
  signal: new AbortController().signal,
};
function showDialog(overrides: Partial<DialogOptions> = {}) {
  const submit = overrides.submit ?? vi.fn(() => null);
  const completed = fixture.track(
    showPersonalSessionGroupDialog({ ...options, ...overrides, submit }),
  );
  return { completed, submit };
}
async function openDialog(overrides: Partial<DialogOptions> = {}) {
  return {
    ...showDialog(overrides),
    ...(await getRenderedModalDialog(document.body)),
  };
}
function searchInput(modal: ParentNode) {
  return modal.querySelector<HTMLInputElement>('input[type="search"]');
}
function searchToggle(modal: ParentNode) {
  return modal.querySelector<HTMLButtonElement>('button[aria-label="Search sessions"]');
}
function keydown(target: EventTarget, value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
async function openSearch(modal: ParentNode) {
  searchToggle(modal)!.click();
  await waitForSolid(() => expect(searchInput(modal)).not.toBeNull());
  return searchInput(modal)!;
}

beforeEach(() => {
  restorePopover = installPopoverPolyfill();
  fixture = createModalDialogTestFixture();
});
afterEach(() => fixture.cleanup().finally(restorePopover));

it("keeps Enter from submitting the section during IME composition", async () => {
  const { modal, submit } = await openDialog();
  const input = await openSearch(modal);
  // Android/Chrome deliver the committing Enter while isComposing is still set.
  const event = keydown(input, "Enter", { isComposing: true, keyCode: 229 });
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  expect(searchInput(modal)).toBe(input);
  // The dialog stays open; nothing was saved.
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
});

it("keeps Enter from submitting the section in the WebKit composition-end grace window", async () => {
  const { modal, submit } = await openDialog();
  const input = await openSearch(modal);
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  // WebKit can clear both composition flags before the committing Enter arrives.
  const event = keydown(input, "Enter", { keyCode: 13 });
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  expect(document.body.querySelector("openclaw-modal-dialog")).not.toBeNull();
});

it("does not close search while Escape is composing, then clears on a settled Escape", async () => {
  const { modal } = await openDialog();
  const input = await openSearch(modal);
  input.value = "alpha";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  // During composition Escape belongs to the input method: it must not clear or close.
  keydown(input, "Escape", { isComposing: true, keyCode: 229 });
  expect(searchInput(modal)).toBe(input);
  // Once composition is over, Escape clears the query and closes search.
  keydown(input, "Escape", {});
  await waitForSolid(() => expect(searchInput(modal)).toBeNull());
});
