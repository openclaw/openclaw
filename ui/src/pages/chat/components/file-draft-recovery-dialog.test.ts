/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import {
  installDialogPolyfill,
  waitForRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { reviewFileDrafts, type FileDraft } from "./file-draft-recovery-dialog.ts";

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
  const found = [...modal.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!found) {
    throw new Error(`Missing dialog button: ${text}`);
  }
  return found;
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
  let finishCopy!: (copied: boolean) => void;
  clipboard.copy.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finishCopy = resolve;
      }),
  );
  const entry = draft("pending.md");
  const result = reviewFileDrafts([entry]);
  const { modal } = await waitForRenderedModalDialog(document.body);
  button(modal, "Copy pending.md").click();
  expect(clipboard.copy).toHaveBeenCalledOnce();
  button(modal, "Keep").click();
  await result;
  finishCopy(true);
  await waitForSolid(() => expect(document.querySelector("openclaw-modal-dialog")).toBeNull());
  expect(entry.discard).not.toHaveBeenCalled();
});
