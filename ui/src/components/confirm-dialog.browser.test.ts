import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { getRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";
import { showInputDialog } from "./input-dialog.tsx";
import "../styles.css";

let controller: AbortController;
let trigger: HTMLButtonElement;
async function setViewport(width: number, height: number) {
  await page.viewport(width, height);
  // The parent viewport command can finish before the test iframe resizes.
  await expect.poll(() => window.innerWidth).toBe(width);
}
beforeEach(async () => {
  await setViewport(1280, 720);
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
  it("retains confirmation while live authority is unavailable", async () => {
    const live = createRoot((dispose) => {
      const [connected, setConnected] = createSignal(true);
      return { connected, setConnected, dispose };
    });
    try {
      const result = showConfirmDialog({
        message: "Remove synthetic device?",
        canConfirm: live.connected,
        signal: controller.signal,
      });
      const { dialog } = await getRenderedModalDialog(document.body);
      const submit = button("Confirm");
      expect(submit.disabled).toBe(false);
      live.setConnected(false);
      flush();
      expect(submit.disabled).toBe(true);
      submit.click();
      expect(dialog.open).toBe(true);
      live.setConnected(true);
      flush();
      expect(submit.disabled).toBe(false);
      submit.click();
      await expect(result).resolves.toBe(true);
    } finally {
      live.dispose();
    }
  });

  it("aligns mobile choices, focuses Cancel, and restores the opener", async () => {
    await setViewport(390, 844);
    const result = showConfirmChoiceDialog({
      message: "Change this session?",
      confirmLabel: "Save",
      alternativeLabel: "Discard",
      signal: controller.signal,
    });
    const { dialog } = await getRenderedModalDialog(document.body);
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    const top = button("Cancel").getBoundingClientRect().top;
    for (const label of ["Discard", "Save"]) {
      expect(Math.abs(button(label).getBoundingClientRect().top - top)).toBeLessThanOrEqual(1);
    }
    button("Discard").click();
    expect(document.activeElement).toBe(trigger);
    await expect(result).resolves.toBe("alternative");
  });

  it("keeps grouped mobile choices in visual DOM order without losing keyboard focus", async () => {
    await setViewport(390, 844);
    const secondary = "Archive only this session";
    const primary = "Archive all (3)";
    const result = showConfirmChoiceDialog({
      message: "Synthetic nested-session scope",
      confirmLabel: primary,
      alternativeLabel: secondary,
      groupChoicesOnMobile: true,
      signal: controller.signal,
    });
    await getRenderedModalDialog(document.body);
    const order = () =>
      [...document.querySelectorAll("openclaw-modal-actions button")].map((control) =>
        control.textContent?.trim(),
      );
    await expect.poll(order).toEqual([secondary, primary, "Cancel"]);
    expect(document.activeElement).toBe(button("Cancel"));
    for (const name of [secondary, primary, "Cancel"]) {
      // macOS WebKit uses Option-Tab to visit each control inside the dialog.
      if (
        navigator.platform.includes("Mac") &&
        navigator.userAgent.includes("AppleWebKit") &&
        !navigator.userAgent.includes("Chrome")
      ) {
        await userEvent.keyboard("{Alt>}{Tab}{/Alt}");
      } else {
        await userEvent.tab();
      }
      expect(document.activeElement).toBe(button(name));
    }
    for (const width of [1280, 390, 320, 390]) {
      await setViewport(width, 844);
      await expect
        .poll(order)
        .toEqual(width === 1280 ? ["Cancel", secondary, primary] : [secondary, primary, "Cancel"]);
      await expect.poll(() => document.activeElement).toBe(button("Cancel"));
    }
    button(primary).focus();
    for (const width of [1280, 390]) {
      await setViewport(width, 844);
      await expect
        .poll(order)
        .toEqual(width === 1280 ? ["Cancel", secondary, primary] : [secondary, primary, "Cancel"]);
      await expect.poll(() => document.activeElement).toBe(button(primary));
    }
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps pending input open during native cancellation", async () => {
    const pending = createDeferred<string | null>();
    const result = showInputDialog({
      title: "Rename session",
      defaultValue: "Synthetic session",
      signal: controller.signal,
      submit: () => pending.promise,
    });
    const { dialog, modal } = await getRenderedModalDialog(document.body);
    const input = modal.querySelector<HTMLInputElement>('input[name="value"]')!;
    expect(document.activeElement).toBe(input);
    button("Save").click();
    await waitForSolid(() => expect(input.disabled).toBe(true));
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog.open).toBe(true);
    pending.resolve(null);
    await expect(result).resolves.toBe("Synthetic session");
    expect(document.activeElement).toBe(trigger);
  });
});
