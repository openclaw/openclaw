/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
} from "../../app/native-device-settings.ts";
import { client, type RequestFn } from "../../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { updateRunHarness } from "../../app/update-run.test-support.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import { mountConfigCommandRoutes } from "./updates.test-support.ts";

it.each([
  { command: "report", replacement: "route" },
  { command: "report", replacement: "connection" },
  { command: "native", replacement: "route" },
] as const)(
  "retires pending $command presentation on $replacement replacement",
  async ({ command, replacement }) => {
    const preview = Promise.withResolvers<unknown>();
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    const request = vi.fn<RequestFn>((method) =>
      method === "update.report" ? preview.promise : Promise.resolve({ lastRun: run }),
    );
    const harness = updateRunHarness(request);
    harness.update({ selfUser: { id: "synthetic-admin" } });
    const overlays = createApplicationOverlays(harness.gateway);
    const nativeSnapshot = createNativeDeviceSettingsSnapshot();
    const nativePost = vi
      .fn<(message: unknown) => Promise<unknown>>()
      .mockResolvedValue(nativeSnapshot);
    let nativeDeviceSettings: NativeDeviceSettingsCapability | null = null;
    if (command === "native") {
      vi.stubGlobal("webkit", {
        messageHandlers: { openclawDeviceSettings: { postMessage: nativePost } },
      });
      vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", nativeSnapshot);
      nativeDeviceSettings = createNativeDeviceSettingsCapability();
      nativePost.mockReturnValueOnce(preview.promise);
    }
    // SAFETY: completeConfigContext fills the unrelated capabilities for this route fixture.
    const context: ApplicationContext = {
      ...completeConfigContext({ gateway: harness.gateway } as unknown as ApplicationContext),
      overlays,
      nativeDeviceSettings,
    };
    const { router, view } = await mountConfigCommandRoutes(context, "updates", "advanced");
    const reportButton = () => {
      const button = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Report update failure",
      );
      expect(button!.disabled).toBe(false);
      return button!;
    };
    try {
      await router.navigate("updates", context);
      if (command === "report") {
        (await waitForSolid(reportButton)).click();
        await waitForSolid(() => expect(overlays.snapshot.updateFailureReportBusy).toBe(true));
      } else {
        const input = await waitForSolid(() => {
          const row = [...view.querySelectorAll(".settings-row")].find((candidate) =>
            candidate.textContent?.includes("Check for updates automatically"),
          );
          const toggleInput = row?.querySelector<HTMLInputElement>('input[role="switch"]');
          expect(toggleInput?.checked).toBe(true);
          return toggleInput!;
        });
        input.checked = false;
        input.dispatchEvent(new Event("change"));
        await waitForSolid(() => {
          expect(input.checked).toBe(false);
          expect(input.getAttribute("aria-disabled")).toBe("true");
        });
      }
      if (replacement === "route") {
        await router.navigate("advanced", context);
        const advanced = await waitForSolid(() => {
          expect(view.querySelector(".page-title")?.textContent).toBe("Advanced");
          const content = view.querySelector(".config-content");
          expect(content).not.toBeNull();
          expect(view.querySelector("#config-section-update")).toBeNull();
          return content;
        });
        if (command === "report") {
          expect(overlays.snapshot.updateFailureReportBusy).toBe(true);
          preview.resolve(null);
          await waitForSolid(() => expect(overlays.snapshot.updateFailureReportBusy).toBe(false));
        } else {
          expect(context.nativeDeviceSettings?.snapshot?.updates?.automatic).toBe(true);
          preview.resolve({
            ...nativeSnapshot,
            updates: { ...nativeSnapshot.updates, automatic: false },
          });
          await waitForSolid(() =>
            expect(context.nativeDeviceSettings?.snapshot?.updates?.automatic).toBe(false),
          );
        }
        expect(view.querySelector(".config-content")).toBe(advanced);
        expect(view.querySelector("#config-section-update")).toBeNull();
      } else {
        harness.update({
          client: client(vi.fn<RequestFn>(() => Promise.resolve({ lastRun: run }))),
        });
        await waitForSolid(reportButton);
        preview.reject(new Error("Retired report preview failed"));
        await vi.dynamicImportSettled();
        expect(overlays.snapshot.updateFailureReportNotice).toBeNull();
      }
    } finally {
      preview.resolve(null);
      view.dispose();
      router.stop();
      overlays.dispose();
      context.nativeDeviceSettings?.dispose();
      vi.unstubAllGlobals();
    }
  },
);
