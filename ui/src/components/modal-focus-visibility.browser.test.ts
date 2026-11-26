import { afterEach, beforeEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "./modal-dialog.tsx";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => container.remove());

async function mount() {
  const opener = document.createElement("button");
  opener.textContent = "Open";
  const modal = document.createElement("openclaw-modal-dialog");
  modal.manual = true;
  modal.label = "Confirm";
  modal.setReturnFocusTarget(opener);
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.autofocus = true;
  const confirm = document.createElement("button");
  confirm.textContent = "Remove";
  modal.initialFocus = () => cancel;
  modal.append(cancel, confirm);
  cancel.addEventListener("click", () => modal.hide());
  modal.addEventListener("modal-cancel", () => modal.hide());
  opener.addEventListener("click", () => modal.show());
  container.append(opener, modal);
  await modal.updateComplete;
  return { opener, modal, cancel, confirm };
}

const ringed = (element: Element) => element.matches(":focus-visible");

it("focuses the initial control without a ring after a pointer open", async () => {
  const { opener, cancel } = await mount();
  await userEvent.click(opener);
  await expect.poll(() => document.activeElement).toBe(cancel);
  expect(ringed(cancel)).toBe(false);
});

it("returns focus to the trigger without a ring after a pointer close", async () => {
  const { opener, cancel } = await mount();
  await userEvent.click(opener);
  await expect.poll(() => document.activeElement).toBe(cancel);
  await userEvent.click(cancel);
  await expect.poll(() => document.activeElement).toBe(opener);
  expect(ringed(opener)).toBe(false);
});

it("keeps the ring through a keyboard open and close", async () => {
  const { opener, cancel } = await mount();
  opener.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement).toBe(cancel);
  expect(ringed(cancel)).toBe(true);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement).toBe(opener);
  expect(ringed(opener)).toBe(true);
});

it("shows the ring on the trigger when the keyboard closes a pointer-opened modal", async () => {
  const { opener, cancel } = await mount();
  await userEvent.click(opener);
  await expect.poll(() => document.activeElement).toBe(cancel);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement).toBe(opener);
  expect(ringed(opener)).toBe(true);
});

it("keeps Tab inside the modal and shows the ring after a pointer open", async () => {
  const { opener, cancel, confirm } = await mount();
  await userEvent.click(opener);
  await expect.poll(() => document.activeElement).toBe(cancel);
  await userEvent.tab();
  expect(document.activeElement).toBe(confirm);
  expect(ringed(confirm)).toBe(true);
  await userEvent.tab();
  expect(document.activeElement).toBe(cancel);
});
