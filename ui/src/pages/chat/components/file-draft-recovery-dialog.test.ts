/* @vitest-environment jsdom */

import { within } from "@solidjs/testing-library";
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

it("retains draft controls through copy feedback and discard, then ignores a dismissed copy", async () => {
  const first = draft("first.md");
  const second = draft("second.md");
  const pending = Promise.withResolvers<boolean>();
  clipboard.copy.mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);
  const result = reviewFileDrafts([first, second]);
  const { modal } = await waitForRenderedModalDialog(document.body);
  const button = (name: string) => within(modal).getByRole("button", { name });
  const copy = button("Copy first.md");
  const secondCopy = button("Copy second.md");
  copy.focus();
  copy.click();
  await waitForSolid(() => expect(copy.textContent).toContain("Copied"));
  expect(document.activeElement).toBe(copy);
  button("Discard first.md").click();
  await waitForSolid(() => {
    expect(first.discard).toHaveBeenCalledOnce();
    expect(modal.textContent).not.toContain("first.md");
    expect(button("Copy second.md")).toBe(secondCopy);
  });
  secondCopy.click();
  expect(clipboard.copy).toHaveBeenCalledTimes(2);
  button("Keep drafts").click();
  await result;
  pending.resolve(true);
  await waitForSolid(() => expect(document.querySelector("openclaw-modal-dialog")).toBeNull());
  expect(second.discard).not.toHaveBeenCalled();
});
