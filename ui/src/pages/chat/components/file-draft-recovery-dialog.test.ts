/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { reviewFileDrafts } from "./file-draft-recovery-dialog-loading.tsx";

type FileDraft = Parameters<typeof reviewFileDrafts>[0][number];

const clipboard = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("../../../lib/clipboard.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/clipboard.ts")>()),
  copyToClipboard: clipboard.copy,
}));

let restoreDialog: () => void;
beforeEach(async () => {
  await i18n.setLocale("en");
  restoreDialog = installDialogPolyfill();
});
afterEach(() => {
  document.querySelector("openclaw-modal-dialog")?.dispatchEvent(new CustomEvent("modal-cancel"));
  restoreDialog();
  clipboard.copy.mockReset();
  document.body.replaceChildren();
});

function draft(name: string): FileDraft {
  let current = true;
  return {
    name,
    path: `notes/${name}`,
    context: undefined,
    content: `${name} draft`,
    isCurrent: () => current,
    discard: vi.fn(() => {
      current = false;
      return true;
    }),
  };
}

function button(modal: HTMLElement, text: string): HTMLButtonElement {
  return expectDefined(
    [...modal.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text)),
    `Missing dialog button: ${text}`,
  );
}

it("keeps focus on the copy action when its feedback changes", async () => {
  clipboard.copy.mockResolvedValue(true);
  const result = reviewFileDrafts([draft("notes.md")]);
  const { modal } = await waitForRenderedModalDialog(document.body);
  const copy = button(modal, "Copy notes.md");
  copy.focus();
  copy.click();
  await waitForSolid(() => expect(copy.textContent).toContain("Copied"));
  expect(document.activeElement).toBe(copy);
  button(modal, "Keep").click();
  await result;
});

it("ignores a copy completion after the review is dismissed", async () => {
  const pending = Promise.withResolvers<boolean>();
  clipboard.copy.mockReturnValue(pending.promise);
  const entry = draft("pending.md");
  const result = reviewFileDrafts([entry]);
  const { modal } = await waitForRenderedModalDialog(document.body);
  button(modal, "Copy pending.md").click();
  expect(clipboard.copy).toHaveBeenCalledOnce();
  button(modal, "Keep").click();
  await result;
  pending.resolve(true);
  await waitForSolid(() => expect(document.querySelector("openclaw-modal-dialog")).toBeNull());
  expect(entry.discard).not.toHaveBeenCalled();
});

it("removes one discarded draft without replacing the remaining draft controls", async () => {
  const first = draft("first.md");
  const second = draft("second.md");
  const result = reviewFileDrafts([first, second]);
  const { modal } = await waitForRenderedModalDialog(document.body);
  const secondCopy = button(modal, "Copy second.md");
  button(modal, "Discard first.md").click();
  await waitForSolid(() => {
    expect(first.discard).toHaveBeenCalledOnce();
    expect(modal.textContent).not.toContain("first.md");
    expect(button(modal, "Copy second.md")).toBe(secondCopy);
  });
  button(modal, "Discard second.md").click();
  await result;
  expect(second.discard).toHaveBeenCalledOnce();
});
