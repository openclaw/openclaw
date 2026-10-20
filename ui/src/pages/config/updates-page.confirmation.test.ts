/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { client, type RequestFn } from "../../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { updateRunHarness } from "../../app/update-run.test-support.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import { UpdatesPage } from "./updates-page.tsx";

it.each(["loading", "open"] as const)(
  "retires a Gateway update confirmation when its target changes while %s",
  async (stage) => {
    const dialog = createModalDialogTestFixture();
    const run = createUpdateRunFixture();
    const request = () =>
      dialog.mockRequest<Parameters<RequestFn>, unknown>(async (method) => {
        if (method === "update.run") {
          return { runId: run.runId };
        }
        if (method === "update.runs.get") {
          return { run };
        }
        if (method === "update.status") {
          return {
            updateAvailable: {
              channel: "stable",
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
            },
          };
        }
        return {};
      });
    const requestA = request();
    const requestB = request();
    const harness = updateRunHarness(requestA);
    harness.update({
      hello: {
        ...harness.gateway.snapshot.hello!,
        features: { methods: ["update.run", "update.status"] },
      },
    });
    const overlays = createApplicationOverlays(harness.gateway);
    const context = {
      gateway: harness.gateway,
      overlays,
      config: {
        current: { serverVersion: "1.0.0" },
        subscribe: () => () => undefined,
      },
      nativeDeviceSettings: null,
    } as unknown as ApplicationContext;
    const mounted = mountSolid(() =>
      createComponent(UpdatesPage, {
        context,
        configObject: {},
        configBusy: false,
        updateBusy: false,
      }),
    );
    const updateButton = () => {
      const button = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === "Update now",
      );
      expect(button).toBeDefined();
      expect(button!.disabled).toBe(false);
      return button!;
    };
    const confirmButton = () =>
      document.body.querySelector<HTMLButtonElement>(
        "openclaw-modal-dialog .exec-approval-actions .btn.danger",
      );
    const updateCalls = (calls: typeof requestA.mock.calls) =>
      calls.filter(([method]) => method === "update.run");
    try {
      await overlays.refreshUpdateStatus();
      flush();
      updateButton().click();
      if (stage === "open") {
        await dialog.waitFor(() => expect(confirmButton()).not.toBeNull());
      }
      // No await in the loading case: retire A before the lazy import can resume.
      harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
      harness.update({ client: client(requestB) });
      await vi.dynamicImportSettled();
      confirmButton()?.click();
      await vi.dynamicImportSettled();
      expect(updateCalls(requestA.mock.calls)).toEqual([]);
      expect(updateCalls(requestB.mock.calls)).toEqual([]);
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();

      await overlays.refreshUpdateStatus();
      flush();
      updateButton().click();
      await dialog.waitFor(() => expect(confirmButton()).not.toBeNull());
      confirmButton()!.click();
      await dialog.waitFor(() => expect(updateCalls(requestB.mock.calls)).toHaveLength(1));
      expect(updateCalls(requestA.mock.calls)).toEqual([]);
    } finally {
      mounted.unmount();
      await dialog.cleanup();
      overlays.dispose();
    }
  },
);
