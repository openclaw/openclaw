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

function toggle(title: string) {
  return row(title).querySelector<HTMLInputElement>('input[role="switch"]')!;
}

it.each([
  ["onUpdateNow", "Update Gateway…"],
  ["onReportFailure", "Report update failure"],
] as const)(
  "retains %s progress until its admitted operation completes",
  async (operation, label) => {
    const pending = Promise.withResolvers<void>();
    const command = vi.fn(() => pending.promise);
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    renderUpdates({
      [operation]: command,
      update: { updateRun: run, reportableUpdateFailureId: run.runId },
    });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    button.click();
    expect(command).toHaveBeenCalledOnce();
    pending.resolve();
    await waitForSolid(() => expect(button.disabled).toBe(false));
  },
);

it("offers retry after rollback without telling the user to diagnose before retrying", () => {
  const onUpdateNow = vi.fn(async () => {});
  const run = createUpdateRunFixture({
    status: "failed",
    phase: "finished",
    reason: "The new version did not finish starting; v2026.9.1 is still running",
    verification: {
      serviceRunning: true,
      runningVersion: "2026.9.1",
      coreReady: true,
      rollbackOutcome: { status: "succeeded", reason: "startup timed out" },
    },
  });
  renderUpdates({
    onUpdateNow,
    gatewayVersion: "2026.9.1",
    update: { updateRun: run, reportableUpdateFailureId: run.runId },
  });
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Retry update",
  )!;
  expect(retry.disabled).toBe(false);
  expect(container.textContent).not.toContain("Diagnose the cause before retrying");
  expect(container.textContent).toContain("Report update failure");
  retry.click();
  expect(onUpdateNow).toHaveBeenCalledOnce();
});

it("shows a failed confirmation load and retries the command", async () => {
  const onUpdateNow = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("Confirmation unavailable"))
    .mockResolvedValue(undefined);
  renderUpdates({ onUpdateNow });
  row("Update Gateway…").querySelector<HTMLButtonElement>("button")!.click();
  const alert = () => container.querySelector('[role="alert"]');
  await waitForSolid(() => expect(alert()?.textContent).toContain("Confirmation unavailable"));
  container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForSolid(() => expect(alert()).toBeNull());
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
  const title = "Check for updates automatically";
  const input = toggle(title);
  input.checked = false;
  input.dispatchEvent(new Event("change"));
  await waitForSolid(() => {
    expect(input.checked).toBe(false);
    expect(input.getAttribute("aria-disabled")).toBe("true");
    expect(input.closest(".settings-row")?.textContent).not.toContain("Saving");
  });
  first.reject(new Error("Automatic updates could not be saved"));
  await waitForSolid(() =>
    expect(container.textContent).toContain("Automatic updates could not be saved"),
  );
  row(title).querySelector<HTMLButtonElement>("button")!.click();
  flush();
  second.resolve({ ...snapshot, updates: { ...snapshot.updates, automatic: false } });
  await waitForSolid(() => {
    const confirmed = toggle(title);
    expect(confirmed.getAttribute("aria-disabled")).toBeNull();
    expect(confirmed.checked).toBe(false);
  });
  expect(post.mock.calls.slice(1)).toEqual([
    [{ type: "set", key: "updates.automatic", value: false }],
    [{ type: "set", key: "updates.automatic", value: false }],
  ]);
});
