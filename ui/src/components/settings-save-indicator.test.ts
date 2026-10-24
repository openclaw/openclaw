/* @vitest-environment jsdom */

import { createComponent, createStore, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { saveIndicatorProps } from "./settings-save-indicator.test-support.ts";
import {
  SettingsSaveIndicator,
  type SettingsSaveIndicatorProps,
} from "./settings-save-indicator.tsx";

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
});

describe("settings save indicator", () => {
  it("stays empty while idle", async () => {
    await update();
    expect(indicator.textContent?.trim()).toBe("");
    expect(indicator.querySelector('[role="status"]')).toBeNull();
    await update({ status: "saved" });
    expect(indicator.textContent?.trim()).toBe("");
  });

  it("renders the shared working claw while saving", async () => {
    await update({ status: "saving" });
    expect(indicator.textContent?.trim()).toBe("Saving…");
    expect(part("claw--saving svg .claw-icon__jaw")).not.toBeNull();
    expect(part("claw")).toMatchObject({ ariaHidden: "true" });
  });

  it.each(["elapsed", "unmounted"] as const)("retires the saved timer when %s", async (end) => {
    vi.useFakeTimers();
    const needsApply = end === "elapsed";
    await update({ status: "saving" });
    expect(vi.getTimerCount()).toBe(0);
    await update({ status: "saved", needsApply });
    expect(indicator.textContent).toContain("Saved");
    expect(part("claw--saved")).not.toBeNull();
    expect(part("check")).not.toBeNull();
    // Shell refreshes replace props without restarting the saved window.
    await update({ status: "saved", needsApply });
    expect(vi.getTimerCount()).toBe(1);
    if (end === "unmounted") {
      view.unmount();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } else {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(indicator.textContent).toContain("Saved");
      await vi.advanceTimersByTimeAsync(1);
      flush();
      expect(indicator.textContent?.trim()).toBe("Apply changes");
    }
  });

  it.each([
    ["error", "permission denied", "Save failed"],
    ["rejected", "logging.level: Invalid option", "Settings not applied"],
  ] as const)("explains %s and retries", async (status, lastError, message) => {
    const { onRetry } = await update({ status, lastError });
    const feedback = indicator.querySelector('[role="status"]');
    expect(feedback?.textContent).toContain(message);
    if (status === "error") {
      expect(feedback).toMatchObject({ title: lastError, ariaLabel: `${message}: ${lastError}` });
    } else {
      expect(indicator.textContent).toContain("Current settings are unchanged.");
      expect(indicator.querySelector("details")?.textContent).toContain(lastError);
      expect(indicator.querySelector(".settings-save-indicator--danger")).toBeNull();
    }
    button("Retry")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
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
    expect(next[handler]).toHaveBeenCalledOnce();
    expect(next.onRetry).not.toHaveBeenCalled();
  });

  it("retires the previous failure during a manual save and shows the same error again", async () => {
    const lastError = "permission denied";
    await update({ status: "error", lastError });
    expect(indicator.textContent).toContain("Save failed");
    await update({ status: "error", saving: true, lastError: null });
    expect(indicator.textContent?.trim()).toBe("Saving…");
    expect(indicator.querySelector('[role="status"]')).toMatchObject({ title: "" });
    await update({ status: "error", lastError });
    expect(indicator.textContent).toContain("Save failed");
    expect(indicator.querySelector('[role="status"]')).toMatchObject({ title: lastError });
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
    await waitForSolid(() => expect(indicator.textContent).toContain("Saving…"));
    expect(indicator.querySelector('[aria-busy="true"]')).not.toBeNull();
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
    await waitForSolid(() => expect(indicator.textContent).toContain("Saving…"));
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
