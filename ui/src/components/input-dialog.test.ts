/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showInputDialog } from "./input-dialog.ts";

let restoreDialogPolyfill: () => void;

const findButton = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
const dialogInput = () =>
  document.body.querySelector<HTMLInputElement>('openclaw-modal-dialog input[name="value"]')!;
const dialog = () => document.body.querySelector("openclaw-modal-dialog");
async function open(options: Parameters<typeof showInputDialog>[0]) {
  const closed = showInputDialog(options);
  return { closed, ...(await getRenderedModalDialog(document.body)) };
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

  it("holds a required field closed until it has a non-blank value, then trims it", async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const { closed } = await open({ ...REQUIRED, submit });

    expect(findButton("Create group").disabled).toBe(true);
    await type("   ");
    expect(findButton("Create group").disabled).toBe(true);
    submitForm();
    expect(submit).not.toHaveBeenCalled();

    await type("  Client work  ");
    expect(dialogInput().value).toBe("  Client work  ");
    expect(findButton("Create group").disabled).toBe(false);
    submitForm();

    await closed;
    expect(submit).toHaveBeenCalledExactlyOnceWith("Client work");
    expect(dialog()).toBeNull();
  });

  it("holds a rename closed on the name it started from", async () => {
    const { closed } = await open({
      title: 'Rename group "Research"',
      label: "Group name",
      defaultValue: "Research",
      requireValue: true,
      requireChange: true,
    });
    expect(findButton("Save").disabled).toBe(true);
    await type("  Research  ");
    expect(findButton("Save").disabled).toBe(true);
    submitForm();
    expect(dialog()).not.toBeNull();

    await type("Projects");
    expect(findButton("Save").disabled).toBe(false);
    submitForm();

    await expect(closed).resolves.toBe("Projects");
  });

  it("submits once while an attempt is in flight and blocks dismissal until it settles", async () => {
    const pending = Promise.withResolvers<string | null>();
    const submit = vi.fn().mockReturnValue(pending.promise);
    const { closed, modal } = await open({ ...REQUIRED, submit });

    await type("Client work");
    submitForm();
    submitForm();
    expect(submit).toHaveBeenCalledOnce();
    flush();
    expect(dialogInput().disabled).toBe(true);

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
    let reject!: (error: Error) => void;
    const submit = vi.fn(
      () =>
        new Promise<string | null>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const closed = showInputDialog({ ...REQUIRED, signal: controller.signal, submit });
    await getRenderedModalDialog(document.body);
    await type("Client work");
    submitForm();
    await waitForSolid(() => expect(dialogInput().disabled).toBe(true));

    controller.abort();
    await expect(closed).resolves.toBeNull();
    const successor = showInputDialog({ title: "Next prompt" });
    await getRenderedModalDialog(document.body);
    await type("Still editable");
    reject(new Error("retired operation failed"));
    await waitForSolid(() => {
      expect(dialogInput().value).toBe("Still editable");
      expect(dialogInput().disabled).toBe(false);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith("Client work");
    findButton("Save").click();
    await expect(successor).resolves.toBe("Still editable");
  });

  it.each(["synchronous", "asynchronous"])(
    "recovers from a %s failure without discarding the input",
    async (mode) => {
      const submit = vi
        .fn((): Promise<string | null> => Promise.resolve(null))
        .mockImplementationOnce(() => {
          const error = new Error("gateway exploded");
          if (mode === "synchronous") {
            throw error;
          }
          return Promise.reject(error);
        });
      const { closed } = await open({ ...REQUIRED, submit });

      await type("Client work");
      submitForm();
      await waitForSolid(() => expect(document.body.textContent).toContain("gateway exploded"));

      expect(submit).toHaveBeenCalledOnce();
      expect(dialogInput()).toMatchObject({ disabled: false, value: "Client work" });
      expect(findButton("Create group").disabled).toBe(false);
      expect(document.activeElement).toBe(dialogInput());

      submitForm();
      await closed;
      expect(dialog()).toBeNull();
    },
  );
});
