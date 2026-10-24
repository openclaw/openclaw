/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
} from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import {
  createUpdatesViewDom,
  createUpdatesViewProps,
  type UpdatesViewOverrides,
} from "./updates.test-support.ts";

let nativeCapability: NativeDeviceSettingsCapability | null;
let container: ReturnType<typeof createUpdatesViewDom>["container"];
let mountUpdates: ReturnType<typeof createUpdatesViewDom>["mountUpdates"];
let row: ReturnType<typeof createUpdatesViewDom>["row"];

beforeEach(async () => {
  await i18n.setLocale("en");
  ({ container, row, mountUpdates } = createUpdatesViewDom());
});

afterEach(() => {
  nativeCapability?.dispose();
  nativeCapability = null;
  vi.unstubAllGlobals();
});

function renderUpdates(overrides: UpdatesViewOverrides = {}) {
  mountUpdates(createUpdatesViewProps(overrides));
}

function failedRun() {
  return createUpdateRunFixture({ status: "failed", phase: "finished", reason: "build-failed" });
}

function toggle(title: string) {
  return row(title).querySelector<HTMLInputElement>('input[role="switch"]')!;
}

it.each(["confirmation", "report"] as const)(
  "retains %s progress until its admitted operation completes",
  async (operation) => {
    const confirmation = Promise.withResolvers<void>();
    const report = Promise.withResolvers<void>();
    const onUpdateNow = vi.fn(() => confirmation.promise);
    const onReportFailure = vi.fn(() => report.promise);
    const run = failedRun();
    renderUpdates({
      onUpdateNow,
      onReportFailure,
      update: { updateRun: run, reportableUpdateFailureId: run.runId },
    });
    const label = operation === "confirmation" ? "Update Gateway…" : "Report update failure";
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    button.click();
    expect(operation === "confirmation" ? onUpdateNow : onReportFailure).toHaveBeenCalledOnce();
    if (operation === "confirmation") {
      confirmation.resolve();
    } else {
      report.resolve();
    }
    await waitForSolid(() => expect(button.disabled).toBe(false));
  },
);

it("shows a failed confirmation load and retries the command", async () => {
  const onUpdateNow = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Confirmation unavailable"))
    .mockResolvedValue(undefined);
  renderUpdates({ onUpdateNow });
  row("Update Gateway…").querySelector<HTMLButtonElement>("button")!.click();
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Confirmation unavailable",
    ),
  );
  container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  expect(onUpdateNow).toHaveBeenCalledTimes(2);
});

it("keeps native automatic-update intent until acknowledgement and permits retry after failure", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  const post = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawDeviceSettings: { postMessage: post } },
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  nativeCapability = createNativeDeviceSettingsCapability();
  post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  renderUpdates({ nativeDeviceSettings: nativeCapability });
  const input = toggle("Check for updates automatically");
  input.checked = false;
  input.dispatchEvent(new Event("change"));
  await waitForSolid(() => {
    expect(input.checked).toBe(false);
    expect(input.getAttribute("aria-disabled")).toBe("true");
  });
  first.reject(new Error("Automatic updates could not be saved"));
  await waitForSolid(() =>
    expect(container.textContent).toContain("Automatic updates could not be saved"),
  );
  const retry = row("Check for updates automatically").querySelector<HTMLButtonElement>("button")!;
  retry.click();
  flush();
  second.resolve({ ...snapshot, updates: { ...snapshot.updates, automatic: false } });
  await waitForSolid(() => {
    const confirmed = toggle("Check for updates automatically");
    expect(confirmed.getAttribute("aria-disabled")).toBeNull();
    expect(confirmed.checked).toBe(false);
  });
  expect(post.mock.calls.slice(1)).toEqual([
    [{ type: "set", key: "updates.automatic", value: false }],
    [{ type: "set", key: "updates.automatic", value: false }],
  ]);
});
