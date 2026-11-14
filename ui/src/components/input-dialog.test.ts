/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showInputDialog } from "./input-dialog.tsx";

let restoreDialogPolyfill: () => void;

const findButton = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
const dialogInput = () =>
  document.body.querySelector<HTMLInputElement>('openclaw-modal-dialog input[name="value"]')!;
const dialog = () => document.body.querySelector("openclaw-modal-dialog");
const alert = () => document.querySelector('[role="alert"]');
const expectSaving = () => waitForSolid(() => expect(dialogInput().disabled).toBe(true));
async function open(options: Parameters<typeof showInputDialog>[0]) {
  const closed = showInputDialog(options);
  return { closed, ...(await getRenderedModalDialog(document.body)) };
}

async function enter(value = "Client work") {
  await type(value);
  submitForm();
}

async function type(value: string) {
  const input = dialogInput();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
}

function submitForm() {
  document.body
    .querySelector("openclaw-modal-dialog form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

const REQUIRED = {
  title: "New group",
  label: "New group name",
  submitLabel: "Create group",
  requireValue: true,
} as const;

describe("showInputDialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
  });

  it.each(["dismissal", "owner abort"])("cancels and removes the dialog on %s", async (reason) => {
    const controller = new AbortController();
    const { closed, modal } = await open({ title: "Rename session", signal: controller.signal });
    if (reason === "dismissal") {
      modal.dispatchEvent(new CustomEvent("modal-cancel"));
    } else {
      controller.abort();
    }
    await expect(closed).resolves.toBeNull();
    expect(dialog()).toBeNull();
  });

  it("allows an explicitly admitted offline submit and updates admission with the Gateway", async () => {
    const harness = createGatewayHarness(null, false);
    const submit = vi.fn().mockResolvedValue(null);
    const { closed } = await open({
      title: "Rename session",
      gateway: harness.gateway,
      canSubmit: () => harness.gateway.snapshot.phase === "offline",
      submit,
    });
    await type("Notes");
    expect(findButton("Save").disabled).toBe(true);
    harness.update({ phase: "offline" });
    flush();
    expect(findButton("Save").disabled).toBe(false);
    submitForm();
    await expect(closed).resolves.toBe("Notes");
    expect(submit).toHaveBeenCalledExactlyOnceWith("Notes");
  });

  it("rejects a reentrant input request instead of stacking or replaying it", async () => {
    const first = showInputDialog({ title: "First" });
    const second = showInputDialog({ title: "Second" });
    await getRenderedModalDialog(document.body);

    expect(document.body.textContent).toContain("First");
    expect(document.body.textContent).not.toContain("Second");
    await expect(second).resolves.toBeNull();
    findButton("Cancel").click();
    await expect(first).resolves.toBeNull();
  });

  it.each([undefined, "Research"])(
    "blocks blank/unchanged values (initial=%s), then trims",
    async (initial) => {
      const submit = vi.fn().mockResolvedValue(null);
      const { closed } = await open({
        ...REQUIRED,
        defaultValue: initial,
        requireChange: initial !== undefined,
        submit,
      });
      const button = findButton("Create group");
      expect(button.disabled).toBe(true);
      await enter(`  ${initial ?? ""}  `);
      expect(button.disabled).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      await type("  Client work  ");
      expect(dialogInput().value).toBe("  Client work  ");
      expect(button.disabled).toBe(false);
      submitForm();
      await expect(closed).resolves.toBe("Client work");
      expect(submit).toHaveBeenCalledExactlyOnceWith("Client work");
      expect(dialog()).toBeNull();
    },
  );

  it("submits once while an attempt is in flight and blocks dismissal until it settles", async () => {
    const pending = Promise.withResolvers<string | null>();
    const submit = vi.fn().mockReturnValue(pending.promise);
    const { closed, modal } = await open({ ...REQUIRED, submit });

    await enter();
    submitForm();
    expect(submit).toHaveBeenCalledOnce();
    await expectSaving();

    const cancelEvent = new CustomEvent("modal-cancel", { cancelable: true });
    modal.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();

    pending.resolve(null);
    await closed;
    expect(dialog()).toBeNull();
  });

  it("keeps the successor editable after an aborted submission fails late", async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<string | null>();
    const submit = vi.fn(() => pending.promise);
    const { closed } = await open({ ...REQUIRED, signal: controller.signal, submit });
    await enter();
    await expectSaving();

    controller.abort();
    await expect(closed).resolves.toBeNull();
    const { closed: successor } = await open({ title: "Next prompt" });
    await type("Still editable");
    pending.reject(new Error("retired operation failed"));
    await waitForSolid(() => {
      expect(dialogInput()).toMatchObject({ value: "Still editable", disabled: false });
      expect(alert()).toBeNull();
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith("Client work");
    findButton("Save").click();
    await expect(successor).resolves.toBe("Still editable");
  });

  it.each(["synchronous", "asynchronous", "validation"])(
    "recovers from a %s failure without discarding the input",
    async (mode) => {
      const retry = Promise.withResolvers<string | null>();
      const submit = vi
        .fn(() => retry.promise)
        .mockImplementationOnce(() => {
          const error = new Error("gateway exploded");
          if (mode === "synchronous") {
            throw error;
          }
          return mode === "validation" ? Promise.resolve(error.message) : Promise.reject(error);
        });
      const { closed } = await open({ ...REQUIRED, submit });

      await type("Client work");
      const input = dialogInput();
      submitForm();
      await waitForSolid(() => expect(document.body.textContent).toContain("gateway exploded"));

      expect(dialogInput()).toBe(input);
      expect(dialogInput()).toMatchObject({ disabled: false, value: "Client work" });
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(findButton("Create group").disabled).toBe(false);
      expect(document.activeElement).toBe(dialogInput());

      submitForm();
      submitForm();
      expect(submit).toHaveBeenCalledTimes(2);
      await expectSaving();
      expect(dialogInput()).toBe(input);
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      expect(alert()).toBeNull();
      retry.resolve(null);
      await expect(closed).resolves.toBe("Client work");
      expect(dialog()).toBeNull();
    },
  );
});
