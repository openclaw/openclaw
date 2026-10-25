/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findButton } from "../test-helpers/dom-probe.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  showConfirmChoiceDialog,
  showConfirmDialog,
  type ConfirmDialogOptions,
} from "./confirm-dialog.ts";

let restoreDialogPolyfill: () => void;

function setCheckbox(selector: string, checked: boolean) {
  const checkbox = document.body.querySelector<HTMLInputElement>(selector);
  if (!checkbox) {
    throw new Error(`Missing checkbox: ${selector}`);
  }
  checkbox.checked = checked;
  checkbox.dispatchEvent(new Event("change"));
}

async function show(options: Partial<ConfirmDialogOptions> = {}) {
  const result = showConfirmDialog({ message: "Continue?", ...options });
  return { result, ...(await getRenderedModalDialog(document.body)) };
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
    const { result, modal, dialog } = await show({
      title: "Delete thread?",
      message: "This cannot be undone.",
      details: "thread-1",
      confirmLabel: "Delete",
      danger: true,
    });
    expect(dialog.getAttribute("aria-label")).toBe("Delete thread?");
    expect(dialog.getAttribute("aria-description")).toBe("This cannot be undone.");
    expect(modal.textContent).toContain("thread-1");
    expect(findButton("Delete").classList.contains("danger")).toBe(true);
    findButton("Delete").click();
    await expect(result).resolves.toBe(true);
    expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("requires an acknowledgement even when an old skip preference is set", async () => {
    const { result } = await show({
      message: "Recover capture?",
      requiredAcknowledgement: "Provider cleanup is complete",
      skipPreference: { skipped: true, remember: vi.fn() },
    });
    expect(findButton("Confirm").disabled).toBe(true);
    expect(document.body.querySelector(".exec-approval-skip")).toBeNull();
    setCheckbox('input[type="checkbox"]', true);
    flush();
    expect(findButton("Confirm").disabled).toBe(false);
    setCheckbox('input[type="checkbox"]', false);
    flush();
    expect(findButton("Confirm").disabled).toBe(true);
    findButton("Cancel").click();
    await expect(result).resolves.toBe(false);
  });

  it.each([
    { action: "Cancel", skipped: false, result: false, remembered: 0 },
    { action: "Confirm", skipped: false, result: true, remembered: 1 },
    { action: "Confirm", skipped: true, result: true, remembered: 0 },
  ])("remembers only a confirmed opt-out (action=$action, skipped=$skipped)", async (choice) => {
    const remember = vi.fn();
    const pending = showConfirmDialog({
      message: "Delete?",
      skipPreference: { skipped: choice.skipped, remember },
    });
    if (!choice.skipped) {
      await getRenderedModalDialog(document.body);
      setCheckbox('.exec-approval-skip input[type="checkbox"]', true);
      findButton(choice.action).click();
    }
    await expect(pending).resolves.toBe(choice.result);
    expect(remember).toHaveBeenCalledTimes(choice.remembered);
    if (choice.skipped) {
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
    }
  });

  it.each(["confirm", "alternative"] as const)(
    "keeps grouped choices gated by acknowledgement and live authority: %s",
    async (choice) => {
      let allowed = true;
      const pending = showConfirmChoiceDialog({
        message: "Choose a scope",
        alternativeLabel: "Only this session",
        confirmLabel: "All sessions",
        groupChoicesOnMobile: true,
        requiredAcknowledgement: "I understand",
        canConfirm: () => allowed,
      });
      const { dialog } = await getRenderedModalDialog(document.body);
      const selected = findButton(choice === "confirm" ? "All sessions" : "Only this session");
      expect(selected.disabled).toBe(true);
      setCheckbox('input[type="checkbox"]', true);
      flush();
      expect(selected.disabled).toBe(false);
      // A stale enabled appearance must not bypass the live click guard.
      allowed = false;
      selected.click();
      expect(dialog.open).toBe(true);
      allowed = true;
      selected.click();
      await expect(pending).resolves.toBe(choice);
    },
  );

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
      "Cancel",
      "All sessions",
      "This session",
    ]);
    expect(findButton("This session").classList.contains("primary")).toBe(true);
    expect(findButton("All sessions").className).toBe("btn");
    expect(findButton("Cancel").hasAttribute("autofocus")).toBe(true);
    findButton(button).click();
    await expect(pending).resolves.toBe(result);
  });

  it.each(
    [
      { choice: false, grouped: false },
      { choice: true, grouped: false },
      { choice: true, grouped: true },
    ].flatMap((mode) =>
      ["abort", "dismiss"].map((action) => ({
        choice: mode.choice,
        grouped: mode.grouped,
        action,
      })),
    ),
  )(
    "cancels choice=$choice grouped=$grouped on $action without stacking",
    async ({ choice, grouped, action }) => {
      const controller = new AbortController();
      const options = { message: "Continue?", signal: controller.signal };
      const pending = choice
        ? showConfirmChoiceDialog({
            ...options,
            alternativeLabel: "Alternative",
            groupChoicesOnMobile: grouped,
          })
        : showConfirmDialog(options);
      const { modal } = await getRenderedModalDialog(document.body);
      if (choice) {
        await expect(showConfirmDialog({ message: "Second" })).resolves.toBe(false);
        await expect(
          showConfirmChoiceDialog({ message: "Third", alternativeLabel: "Other" }),
        ).resolves.toBeNull();
      }
      if (action === "abort") {
        controller.abort();
      } else {
        modal.dispatchEvent(new CustomEvent("modal-cancel"));
      }
      await expect(pending).resolves.toBe(choice ? null : false);
      if (choice || action === "abort") {
        expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      }
    },
  );
});
