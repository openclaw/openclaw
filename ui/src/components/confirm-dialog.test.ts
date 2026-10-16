/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";

let restoreDialogPolyfill: () => void;

function tickSkipCheckbox() {
  const checkbox = document.body.querySelector<HTMLInputElement>(
    '.exec-approval-skip input[type="checkbox"]',
  );
  if (!checkbox) {
    throw new Error("Expected the skip-preference checkbox");
  }
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

describe("showConfirmDialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it("renders accessible copy and resolves the selected action", async () => {
    const result = showConfirmDialog({
      title: "Delete thread?",
      message: "This cannot be undone.",
      details: "thread-1",
      confirmLabel: "Delete",
      danger: true,
    });
    const { modal, dialog } = await getRenderedModalDialog(document.body);

    expect(dialog.getAttribute("aria-label")).toBe("Delete thread?");
    expect(dialog.getAttribute("aria-description")).toBe("This cannot be undone.");
    expect(modal.textContent).toContain("thread-1");
    expect(findButton("Delete").classList.contains("danger")).toBe(true);

    findButton("Delete").click();

    await expect(result).resolves.toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("requires an acknowledgement even when an old skip preference is set", async () => {
    const result = showConfirmDialog({
      message: "Recover capture?",
      requiredAcknowledgement: "Provider cleanup is complete",
      skipPreference: { skipped: true, remember: vi.fn() },
    });
    await getRenderedModalDialog(document.body);
    expect(findButton("Confirm").disabled).toBe(true);
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) {
      throw new Error("Expected required acknowledgement");
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    flush();
    expect(findButton("Confirm").disabled).toBe(false);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    flush();
    expect(findButton("Confirm").disabled).toBe(true);
    findButton("Cancel").click();
    await expect(result).resolves.toBe(false);
  });

  it("treats modal dismissal as cancellation", async () => {
    const result = showConfirmDialog({ message: "Continue?" });
    const { modal } = await getRenderedModalDialog(document.body);

    modal.dispatchEvent(new CustomEvent("modal-cancel"));

    await expect(result).resolves.toBe(false);
  });

  it("removes the dialog and cancels when its owner aborts", async () => {
    const controller = new AbortController();
    const result = showConfirmDialog({ message: "Continue?", signal: controller.signal });
    await getRenderedModalDialog(document.body);

    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("remembers the opt-out only when the operator confirms with it ticked", async () => {
    const remember = vi.fn();
    const cancelled = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: false, remember },
    });
    await getRenderedModalDialog(document.body);
    tickSkipCheckbox();
    findButton("Cancel").click();

    await expect(cancelled).resolves.toBe(false);
    expect(remember).not.toHaveBeenCalled();

    const confirmed = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: false, remember },
    });
    await getRenderedModalDialog(document.body);
    tickSkipCheckbox();
    findButton("Confirm").click();

    await expect(confirmed).resolves.toBe(true);
    expect(remember).toHaveBeenCalledOnce();
  });

  it("resolves an opted-out confirmation without rendering a modal", async () => {
    const remember = vi.fn();

    const result = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: true, remember },
    });

    await expect(result).resolves.toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    // Re-remembering a stored choice would rewrite the preference on every run.
    expect(remember).not.toHaveBeenCalled();
  });

  it("rejects a reentrant confirmation instead of stacking or replaying it", async () => {
    const first = showConfirmDialog({ title: "First", message: "First action" });
    const second = showConfirmDialog({ title: "Second", message: "Second action" });
    await getRenderedModalDialog(document.body);

    expect(document.body.textContent).toContain("First");
    expect(document.body.textContent).not.toContain("Second");
    await expect(second).resolves.toBe(false);
    findButton("Cancel").click();
    await expect(first).resolves.toBe(false);
  });

  it.each([
    { button: "This session", result: "confirm" },
    { button: "All sessions", result: "alternative" },
    { button: "Cancel", result: null },
  ] as const)("resolves the choice $result", async ({ button, result }) => {
    const pending = showConfirmChoiceDialog({
      title: "Archive session?",
      message: "Choose which sessions to archive.",
      confirmLabel: "This session",
      alternativeLabel: "All sessions",
    });
    await getRenderedModalDialog(document.body);
    expect([...document.body.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "This session",
      "All sessions",
      "Cancel",
    ]);
    expect(findButton("This session").classList.contains("primary")).toBe(true);
    expect(findButton("All sessions").className).toBe("btn");
    expect(findButton("Cancel").hasAttribute("autofocus")).toBe(true);
    findButton(button).click();
    await expect(pending).resolves.toBe(result);
  });

  it.each(["abort", "dismiss"])(
    "cancels a choice on %s and shares reentrancy protection",
    async (action) => {
      const controller = new AbortController();
      const pending = showConfirmChoiceDialog({
        message: "Choose",
        alternativeLabel: "Alternative",
        signal: controller.signal,
      });
      const { modal } = await getRenderedModalDialog(document.body);
      await expect(showConfirmDialog({ message: "Second" })).resolves.toBe(false);
      await expect(
        showConfirmChoiceDialog({ message: "Third", alternativeLabel: "Other" }),
      ).resolves.toBeNull();
      if (action === "abort") {
        controller.abort();
      } else {
        modal.dispatchEvent(new CustomEvent("modal-cancel"));
      }
      await expect(pending).resolves.toBeNull();
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );
});
