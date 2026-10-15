import { afterEach, describe, expect, it } from "vitest";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";
import { showInputDialog } from "./input-dialog.ts";
import "../styles.css";

const owners: AbortController[] = [];
function owner() {
  const controller = new AbortController();
  owners.push(controller);
  return controller.signal;
}
function opener() {
  const trigger = document.createElement("button");
  trigger.textContent = "Edit synthetic session";
  document.body.append(trigger);
  trigger.focus();
  return trigger;
}
function button(label: string) {
  const result = [...document.querySelectorAll("openclaw-modal-dialog button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(result instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return result;
}

afterEach(async () => {
  for (const controller of owners.splice(0)) {
    controller.abort();
  }
  await Promise.resolve();
  document.body.replaceChildren();
});

describe("promise dialog native focus and dismissal", () => {
  it("keeps Cancel focused in a three-way choice and restores its opener", async () => {
    const trigger = opener();
    const pending = showConfirmChoiceDialog({
      title: "Archive session?",
      message: '"Synthetic session" has a nested session.',
      confirmLabel: "Archive this session",
      alternativeLabel: "Archive 2 sessions",
      signal: owner(),
    });
    await getRenderedModalDialog(document.body);
    expect(document.activeElement).toBe(button("Cancel"));
    button("Archive 2 sessions").click();
    expect(document.activeElement).toBe(trigger);
    await expect(pending).resolves.toBe("alternative");
  });

  it("focuses the safe confirmation action, requires acknowledgement, and restores focus synchronously", async () => {
    const trigger = opener();
    const result = showConfirmDialog({
      title: "Delete synthetic session?",
      message: "This removes the synthetic session from your list.",
      details: "synthetic-session",
      requiredAcknowledgement: "I understand this cannot be undone",
      danger: true,
      confirmLabel: "Delete",
      signal: owner(),
    });
    const { dialog } = await getRenderedModalDialog(document.body);
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    expect(button("Delete").disabled).toBe(true);
    const acknowledgement = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    acknowledgement.click();
    flush();
    expect(button("Delete").disabled).toBe(false);
    button("Cancel").click();
    expect(document.activeElement).toBe(trigger);
    await expect(result).resolves.toBe(false);
  });

  it("keeps a pending input operation visible through native cancellation and preserves its text after rejection", async () => {
    const trigger = opener();
    let settle!: (message: string | null) => void;
    const result = showInputDialog({
      title: "Rename synthetic session",
      defaultValue: "Synthetic session",
      requireChange: true,
      signal: owner(),
      submit: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    const { dialog, modal } = await getRenderedModalDialog(document.body);
    const input = modal.querySelector<HTMLInputElement>('input[name="value"]')!;
    expect(document.activeElement).toBe(input);
    input.value = "Renamed synthetic session";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    button("Save").click();
    flush();
    expect(input.disabled).toBe(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog.open).toBe(true);
    settle("This name is already in use");
    await Promise.resolve();
    flush();
    await Promise.resolve();
    expect(modal.querySelector('[role="alert"]')?.textContent).toBe("This name is already in use");
    expect(input.value).toBe("Renamed synthetic session");
    expect(document.activeElement).toBe(input);
    button("Cancel").click();
    expect(document.activeElement).toBe(trigger);
    await expect(result).resolves.toBeNull();
  });
});
