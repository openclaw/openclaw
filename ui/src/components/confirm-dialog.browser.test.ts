import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";
import { showInputDialog } from "./input-dialog.tsx";
import "../styles.css";

let controller: AbortController;
let trigger: HTMLButtonElement;
beforeEach(() => {
  controller = new AbortController();
  trigger = document.body.appendChild(document.createElement("button"));
  trigger.textContent = "Edit synthetic session";
  trigger.focus();
});
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
}

afterEach(async () => {
  controller.abort();
  await Promise.resolve();
  document.body.replaceChildren();
});

describe("promise dialog native focus and dismissal", () => {
  it.each(["confirmation", "input"] as const)(
    "retains a %s dialog while live submission is unavailable",
    async (kind) => {
      const live = createRoot((dispose) => {
        const [connected, setConnected] = createSignal(true);
        return { connected, setConnected, dispose };
      });
      try {
        const result =
          kind === "input"
            ? showInputDialog({
                title: "Rename synthetic device",
                defaultValue: "Retained device draft",
                canSubmit: live.connected,
                signal: controller.signal,
              })
            : showConfirmDialog({
                title: "Remove synthetic device?",
                message: "Synthetic confirmation",
                canConfirm: live.connected,
                signal: controller.signal,
              });
        const { dialog, modal } = await getRenderedModalDialog(document.body);
        const submit = button(kind === "input" ? "Save" : "Confirm");
        expect(submit.disabled).toBe(false);
        live.setConnected(false);
        flush();
        expect(submit.disabled).toBe(true);
        submit.click();
        modal
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        expect(dialog.open).toBe(true);
        live.setConnected(true);
        flush();
        expect(submit.disabled).toBe(false);
        if (kind === "input") {
          expect(modal.querySelector<HTMLInputElement>('input[name="value"]')?.value).toBe(
            "Retained device draft",
          );
        }
        submit.click();
        await expect(result).resolves.toBe(kind === "input" ? "Retained device draft" : true);
      } finally {
        live.dispose();
      }
    },
  );

  it.each(["acknowledgement", "alternative"] as const)(
    "focuses Cancel and restores the opener: %s",
    async (kind) => {
      const options = {
        title: "Synthetic session",
        message: "Change this session?",
        signal: controller.signal,
      };
      const result =
        kind === "alternative"
          ? showConfirmChoiceDialog({
              ...options,
              confirmLabel: "Archive this session",
              alternativeLabel: "Archive 2 sessions",
            })
          : showConfirmDialog({
              ...options,
              details: "synthetic-session",
              requiredAcknowledgement: "I understand this cannot be undone",
              danger: true,
              confirmLabel: "Delete",
            });
      const { dialog } = await getRenderedModalDialog(document.body);
      expect(dialog.open).toBe(true);
      expect(document.activeElement).toBe(button("Cancel"));
      if (kind === "acknowledgement") {
        expect(button("Delete").disabled).toBe(true);
        document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
        flush();
        expect(button("Delete").disabled).toBe(false);
      }
      button(kind === "alternative" ? "Archive 2 sessions" : "Cancel").click();
      expect(document.activeElement).toBe(trigger);
      await expect(result).resolves.toBe(kind === "alternative" ? "alternative" : false);
    },
  );

  it("keeps a pending input operation visible through native cancellation and preserves its text after rejection", async () => {
    const pending = createDeferred<string | null>();
    const result = showInputDialog({
      title: "Rename synthetic session",
      defaultValue: "Synthetic session",
      requireChange: true,
      signal: controller.signal,
      submit: () => pending.promise,
    });
    const { dialog, modal } = await getRenderedModalDialog(document.body);
    const input = modal.querySelector<HTMLInputElement>('input[name="value"]')!;
    expect(document.activeElement).toBe(input);
    input.value = "Renamed synthetic session";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    button("Save").click();
    await waitForSolid(() => expect(input.disabled).toBe(true));
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog.open).toBe(true);
    pending.resolve("This name is already in use");
    await waitForSolid(() =>
      expect(modal.querySelector('[role="alert"]')?.textContent).toBe(
        "This name is already in use",
      ),
    );
    expect(input.value).toBe("Renamed synthetic session");
    expect(document.activeElement).toBe(input);
    button("Cancel").click();
    expect(document.activeElement).toBe(trigger);
    await expect(result).resolves.toBeNull();
  });
});
