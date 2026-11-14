/* @vitest-environment jsdom */

import { createComponent, createStore, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import { saveIndicatorProps } from "./settings-save-indicator.test-support.ts";
import {
  SettingsSaveIndicator,
  type SettingsSaveIndicatorProps,
} from "./settings-save-indicator.tsx";

vi.mock("./confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./confirm-dialog.ts")>()),
  showConfirmDialog: vi.fn(async () => true),
}));

let indicator: HTMLElement;
let view: ReturnType<typeof mountSolid>;
let setProps: (next: SettingsSaveIndicatorProps) => void;

async function update(overrides: Partial<SettingsSaveIndicatorProps> = {}) {
  const next = saveIndicatorProps(overrides);
  setProps(next);
  flush();
  return next;
}

const part = (name: string) => indicator.querySelector(`.settings-save-indicator__${name}`);

function button(label: string): HTMLButtonElement | undefined {
  return [...indicator.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
  const [state, setState] = createStore(saveIndicatorProps());
  setProps = (next) => setState((draft) => Object.assign(draft, next));
  view = mountSolid(() => createComponent(SettingsSaveIndicator, state));
  indicator = view.container;
});

afterEach(() => {
  view.unmount();
  vi.useRealTimers();
  vi.mocked(showConfirmDialog).mockClear();
});

describe("settings save indicator", () => {
  it("stays empty while idle", async () => {
    await update();
    expect(indicator.textContent?.trim()).toBe("");
    expect(indicator.querySelector('[role="status"]')).toBeNull();
    await update({ status: "saved" });
    expect(indicator.textContent?.trim()).toBe("");
  });

  it("reports an autosave from the first edit through a brief Saved", async () => {
    await update({ pending: true });
    expect(indicator.textContent?.trim()).toBe("Saving…");
    await update({ status: "saving" });
    expect(indicator.textContent?.trim()).toBe("Saving…");
    await update({ status: "saved", savedNotice: true });
    expect(indicator.textContent?.trim()).toBe("Saved");
    await update({ status: "saved" });
    expect(indicator.textContent?.trim()).toBe("");
    expect(indicator.querySelector('[role="status"]')).toBeNull();
  });

  it("lets Saved finish before offering a pending Apply", async () => {
    await update({ status: "saving", needsApply: true });
    expect(button("Apply changes")).toBeUndefined();
    await update({ status: "saved", savedNotice: true, needsApply: true });
    expect(button("Apply changes")).toBeUndefined();
    await update({ status: "saved", needsApply: true });
    expect(button("Apply changes")?.disabled).toBe(false);
  });

  it("keeps a failure in front of newer edits and offers both ways out", async () => {
    const { onRetry, onReload } = await update({
      status: "error",
      lastError: "permission denied",
      pending: true,
      savedNotice: true,
    });
    expect(part("title")?.textContent).toBe("Couldn’t save settings. Try again.");
    expect(indicator.textContent).not.toContain("Saving");
    expect(part("reason")?.textContent).toBe("permission denied");
    button("Discard changes")?.click();
    await waitForSolid(() => expect(onReload).toHaveBeenCalledOnce());
    expect(showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Discard unsaved changes?", danger: true }),
    );
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("keeps the edit when the discard is not confirmed", async () => {
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);
    const { onReload } = await update({ status: "error", lastError: "permission denied" });
    button("Discard changes")?.click();
    await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(onReload).not.toHaveBeenCalled();
    expect(part("title")?.textContent).toBe("Couldn’t save settings. Try again.");
  });

  it.each([
    ["error", "permission denied", "Couldn’t save settings. Try again."],
    ["rejected", "logging.level: Invalid option", "Couldn’t apply settings. Review your changes."],
  ] as const)(
    "explains %s with its reason in view and retries",
    async (status, lastError, title) => {
      const { onRetry } = await update({ status, lastError });
      expect(part("title")?.textContent).toBe(title);
      expect(part("reason")?.textContent).toBe(lastError);
      expect(indicator.querySelector("[aria-expanded]")).toBeNull();
      expect(button("Retry")?.classList.contains("primary")).toBe(true);
      button("Retry")?.click();
      expect(onRetry).toHaveBeenCalledOnce();
    },
  );

  it("offers only Discard when the Gateway could not restore the settings", async () => {
    const lastError = "Settings could not be restored. Your draft is kept.";
    await update({ status: "recovery", lastError });
    expect(part("title")?.textContent).toBe("Couldn’t save settings. Try again.");
    expect(part("reason")?.textContent).toBe(lastError);
    expect(button("Retry")).toBeUndefined();
    expect(button("Discard changes")).toBeDefined();
  });

  it.each([
    ["conflict", "Reload", "onReload"],
    ["paused", "Save", "onSave"],
  ] as const)("offers %s recovery through %s, not Retry", async (status, label, handler) => {
    const next = await update({ status });
    if (status === "conflict") {
      expect(indicator.textContent).toContain("Settings changed elsewhere");
      expect(button("Retry")).toBeUndefined();
    }
    button(label)?.click();
    await waitForSolid(() => expect(next[handler]).toHaveBeenCalledOnce());
    // Reload after a conflict drops the unsaved edit, so it asks like Discard does.
    expect(showConfirmDialog).toHaveBeenCalledTimes(status === "conflict" ? 1 : 0);
    expect(next.onRetry).not.toHaveBeenCalled();
  });

  it("keeps the failure card in place while a retry runs", async () => {
    const held = createDeferred<boolean>();
    const onRetry = vi.fn(() => held.promise);
    await update({ status: "error", lastError: "permission denied", onRetry });
    button("Retry")!.click();
    await waitForSolid(() => expect(part("title")?.textContent).toBe("Saving…"));
    expect(part("reason")?.textContent).toBe("permission denied");
    expect(button("Retry")?.disabled).toBe(true);
    expect(button("Discard changes")?.disabled).toBe(true);
    await update({ status: "saving", saving: true, lastError: null, onRetry });
    expect(part("title")?.textContent).toBe("Saving…");
    expect(part("reason")?.textContent).toBe("permission denied");
    await update({ status: "saved", savedNotice: true, onRetry });
    held.resolve(true);
    await waitForSolid(() => expect(indicator.textContent?.trim()).toBe("Saved"));
  });

  it("retires the previous failure during a manual save and shows the same error again", async () => {
    const lastError = "permission denied";
    await update({ status: "error", lastError });
    expect(indicator.textContent).toContain("Couldn’t save settings. Try again.");
    await update({ status: "error", saving: true, lastError: null });
    expect(indicator.textContent?.trim()).toBe("Saving…");
    await update({ status: "error", lastError });
    expect(indicator.textContent).toContain("Couldn’t save settings. Try again.");
    expect(indicator.querySelector(".settings-save-indicator__reason")?.textContent).toBe(
      lastError,
    );
  });

  it("applies pending changes and reports the in-flight state", async () => {
    const { onApply } = await update({ needsApply: true });

    button("Apply changes")?.click();
    expect(onApply).toHaveBeenCalledOnce();

    await update({ needsApply: true, applying: true, onApply });
    expect(indicator.textContent?.trim()).toBe("Applying…");
    expect(part("spinner")).not.toBeNull();
    expect(button("Apply changes")).toBeUndefined();
  });

  it("presents an admitted Save without inventing an accepted owner result", async () => {
    const held = createDeferred<boolean>();
    const onSave = vi.fn(() => held.promise);
    await update({ status: "paused", onSave });
    button("Save")!.click();
    await waitForSolid(() => expect(indicator.textContent?.trim()).toBe("Saving…"));
    expect(onSave).toHaveBeenCalledOnce();
    held.resolve(false);
    await waitForSolid(() => expect(button("Save")?.disabled).toBe(false));
    expect(indicator.textContent).toContain("Autosave paused after reconnect");
    expect(indicator.textContent).not.toContain("Saved");
  });

  it("consumes a rejected command and allows a later retry", async () => {
    const held = createDeferred<boolean>();
    const onRetry = vi.fn(() => held.promise);
    await update({ status: "error", onRetry });
    button("Retry")!.click();
    await waitForSolid(() => expect(part("title")?.textContent).toBe("Saving…"));
    held.reject(new Error("Synthetic retry transport failed"));
    await waitForSolid(() =>
      expect(indicator.querySelector('[role="alert"]')?.textContent).toContain(
        "Synthetic retry transport failed",
      ),
    );
    const retry = vi.fn(async () => false);
    await update({ status: "error", onRetry: retry });
    button("Retry")!.click();
    await waitForSolid(() => expect(retry).toHaveBeenCalledOnce());
    await waitForSolid(() => expect(indicator.querySelector('[role="alert"]')).toBeNull());
  });
});
