/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { RequestFn } from "../../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { updateRunHarness } from "../../app/update-run.test-support.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CustodianAlertCard } from "./custodian-alert-card.tsx";

it.each(["allowed", "revoked"] as const)(
  "checks live native update authority from the Custodian alert: %s",
  async (authority) => {
    const dialog = createModalDialogTestFixture();
    const request = vi.fn<RequestFn>(async () => ({}));
    const harness = updateRunHarness(request);
    harness.update({
      hello: {
        ...harness.gateway.snapshot.hello!,
        features: { methods: ["update.run"] },
      },
    });
    const overlays = createApplicationOverlays(harness.gateway);
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawUpdate: { postMessage } } });
    const mounted = mountSolid(() =>
      createComponent(CustodianAlertCard, {
        alert: {
          id: "update-available",
          title: "Update available",
          facts: ["Version 2.0.0 is available."],
          question: "Review the update.",
          action: { label: "Update", target: { kind: "update" } },
        },
        context: { gateway: harness.gateway, overlays, navigate: vi.fn() },
        onDismiss: vi.fn(),
      }),
    );
    try {
      mounted.container.querySelector<HTMLButtonElement>(".custodian__alert-action")!.click();
      const confirm = await dialog.waitFor(() => {
        const button = document.body.querySelector<HTMLButtonElement>(
          "openclaw-modal-dialog .exec-approval-actions .btn.danger",
        );
        expect(button?.textContent).toContain("Update Mac app and restart");
        return button!;
      });
      if (authority === "revoked") {
        harness.update({
          hello: {
            ...harness.gateway.snapshot.hello!,
            auth: { role: "operator", scopes: ["operator.read"] },
          },
        });
      }
      confirm.click();
      await vi.dynamicImportSettled();
      if (authority === "allowed") {
        expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
        expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
      } else {
        expect(postMessage).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Administrator access is required",
        );
      }
      expect(request.mock.calls.filter(([method]) => method === "update.run")).toEqual([]);
    } finally {
      mounted.unmount();
      await dialog.cleanup();
      overlays.dispose();
      vi.unstubAllGlobals();
    }
  },
);
