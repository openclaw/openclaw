/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showSessionPlacementTargetDialog } from "./session-placement-move-dialog.tsx";

vi.mock("../app/lazy-custom-element.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lazy-custom-element.ts")>();
  return {
    ...actual,
    ensureCustomElementDefined: vi
      .fn(actual.ensureCustomElementDefined)
      .mockRejectedValueOnce(new Error("Dialog code unavailable")),
  };
});

let restoreDialog: () => void;

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
});

it("can reopen and submit after lazy dialog code fails to load", async () => {
  const options = {
    mode: "move" as const,
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: async () => ({ profiles: [], devices: [] }),
  };

  await expect(showSessionPlacementTargetDialog(options)).rejects.toThrow(
    "Dialog code unavailable",
  );
  expect(document.body.childElementCount).toBe(0);

  const result = showSessionPlacementTargetDialog(options);
  const { modal } = await getRenderedModalDialog(document.body);
  try {
    const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await waitForSolid(() => expect(submit.disabled).toBe(false));
    submit.click();
    await expect(result).resolves.toEqual({ kind: "gateway" });
    expect(document.body.childElementCount).toBe(0);
  } finally {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await result;
  }
});
