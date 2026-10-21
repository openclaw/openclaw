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

it.each(["confirmation", "status", "report"] as const)(
  "retains %s progress until its admitted operation completes",
  async (operation) => {
    const confirmation = Promise.withResolvers<void>();
    const check = Promise.withResolvers<boolean>();
    const report = Promise.withResolvers<void>();
    const onUpdateNow = vi.fn(() => confirmation.promise);
    const onCheckStatus = vi.fn(() => check.promise);
    const onReportFailure = vi.fn(() => report.promise);
    const run = failedRun();
    renderUpdates({
      onUpdateNow,
      onCheckStatus,
      onReportFailure,
      update: { updateRun: run, reportableUpdateFailureId: run.runId },
    });
    const label =
      operation === "confirmation"
        ? "Update now"
        : operation === "status"
          ? "Check status"
          : "Report update failure";
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
    button.click();
    flush();
    expect(button.disabled).toBe(true);
    button.click();
    expect(
      operation === "confirmation"
        ? onUpdateNow
        : operation === "status"
          ? onCheckStatus
          : onReportFailure,
    ).toHaveBeenCalledOnce();
    if (operation === "confirmation") {
      confirmation.resolve();
    } else if (operation === "status") {
      check.resolve(true);
    } else {
      report.resolve();
    }
    await waitForSolid(() => expect(button.disabled).toBe(false));
  },
);

it("retires a pending report presenter when the Gateway target changes", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const run = failedRun();
  const reportButton = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Report update failure",
    )!;
  const firstReport = vi.fn(() => first.promise);
  renderUpdates({
    commandScope: {},
    onReportFailure: firstReport,
    update: { updateRun: run, reportableUpdateFailureId: run.runId },
  });
  reportButton().click();
  flush();
  const secondReport = vi.fn(() => second.promise);
  renderUpdates({
    commandScope: {},
    onReportFailure: secondReport,
    update: { updateRun: run, reportableUpdateFailureId: run.runId },
  });
  expect(reportButton().disabled).toBe(false);
  reportButton().click();
  flush();
  second.resolve();
  await waitForSolid(() => expect(reportButton().disabled).toBe(false));
  expect(secondReport).toHaveBeenCalledOnce();
  first.resolve();
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
  flush();
  expect(input.checked).toBe(false);
  expect(input.disabled).toBe(true);
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
    expect(confirmed.disabled).toBe(false);
    expect(confirmed.checked).toBe(false);
  });
  expect(post.mock.calls.slice(1)).toEqual([
    [{ type: "set", key: "updates.automatic", value: false }],
    [{ type: "set", key: "updates.automatic", value: false }],
  ]);
});
