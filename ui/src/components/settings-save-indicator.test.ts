/* @vitest-environment jsdom */

import { createComponent, createStore, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  SettingsSaveIndicator,
  type SettingsSaveIndicatorProps,
} from "./settings-save-indicator.tsx";

let indicator: HTMLElement;
let view: ReturnType<typeof mountSolid>;
let setProps: (next: SettingsSaveIndicatorProps) => void;

function props(overrides: Partial<SettingsSaveIndicatorProps> = {}): SettingsSaveIndicatorProps {
  return {
    status: "idle",
    lastError: null,
    needsApply: false,
    applying: false,
    applyDisabled: false,
    onRetry: vi.fn(),
    onSave: vi.fn(),
    onReload: vi.fn(),
    onApply: vi.fn(),
    ...overrides,
  };
}

async function update(next: SettingsSaveIndicatorProps): Promise<void> {
  setProps(next);
  flush();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...indicator.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
  const [state, setState] = createStore(props());
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
    await update(props());

    expect(indicator.textContent?.trim()).toBe("");
    expect(indicator.querySelector('[role="status"]')).toBeNull();
    await update(props({ status: "saved" }));
    expect(indicator.textContent?.trim()).toBe("");
  });

  it("renders the shared working claw while saving", async () => {
    await update(props({ status: "saving" }));

    expect(indicator.textContent?.trim()).toBe("Saving…");
    expect(
      indicator.querySelector(".settings-save-indicator__claw--saving svg .claw-icon__jaw"),
    ).not.toBeNull();
    expect(
      indicator.querySelector(".settings-save-indicator__claw")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("shows saved for two seconds after saving, then returns to apply", async () => {
    vi.useFakeTimers();
    await update(props({ status: "saving" }));
    await update(props({ status: "saved", needsApply: true }));

    expect(indicator.textContent).toContain("Saved");
    expect(indicator.querySelector(".settings-save-indicator__claw--saved")).not.toBeNull();
    expect(indicator.querySelector(".settings-save-indicator__check")).not.toBeNull();

    // Shell refreshes replace the props object without changing the save status.
    await update(props({ status: "saved", needsApply: true }));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(indicator.textContent).toContain("Saved");
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(indicator.textContent?.trim()).toBe("Apply changes");
  });

  it("surfaces save errors and retries with the original message", async () => {
    const onRetry = vi.fn();
    await update(props({ status: "error", lastError: "permission denied", onRetry }));

    const status = indicator.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Save failed");
    expect(status?.getAttribute("title")).toBe("permission denied");
    expect(status?.getAttribute("aria-label")).toBe("Save failed: permission denied");
    button("Retry")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reloads on conflicts instead of offering retry", async () => {
    const onReload = vi.fn();
    await update(props({ status: "conflict", onReload }));

    expect(indicator.textContent).toContain("Settings changed elsewhere");
    expect(button("Retry")).toBeUndefined();
    button("Reload")?.click();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("explains validation rejection locally with a reason and retry action", async () => {
    const onRetry = vi.fn();
    await update(
      props({ status: "rejected", lastError: "logging.level: Invalid option", onRetry }),
    );

    expect(indicator.querySelector('[role="status"]')?.textContent).toContain(
      "Settings not applied",
    );
    expect(indicator.textContent).toContain("Current settings are unchanged.");
    expect(indicator.querySelector("details")?.textContent).toContain(
      "logging.level: Invalid option",
    );
    expect(indicator.querySelector(".settings-save-indicator--danger")).toBeNull();
    button("Retry")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("submits the paused draft through Save instead of retrying a failed patch", async () => {
    const onSave = vi.fn();
    const onRetry = vi.fn();
    await update(props({ status: "paused", onSave, onRetry }));

    button("Save")?.click();

    expect(onSave).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("applies pending changes and reports the in-flight state", async () => {
    const onApply = vi.fn();
    await update(props({ needsApply: true, onApply }));

    button("Apply changes")?.click();
    expect(onApply).toHaveBeenCalledOnce();

    await update(props({ needsApply: true, applying: true, onApply }));
    expect(indicator.textContent?.trim()).toBe("Applying…");
    expect(indicator.querySelector(".settings-save-indicator__spinner")).not.toBeNull();
    expect(button("Apply changes")).toBeUndefined();
  });

  it("cleans the saved timer when unmounted", async () => {
    vi.useFakeTimers();
    await update(props({ status: "saving" }));
    expect(vi.getTimerCount()).toBe(0);
    await update(props({ status: "saved" }));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
  });
});
