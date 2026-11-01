/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showOwnerDevicesDialog } from "./owner-devices-dialog.tsx";

// Empty owner-device state avoids keys and exercises the production dialog gate.
describe("owner key regeneration placement", () => {
  afterEach(() => {
    cleanupSolid();
  });
  it.each(["local_operator", "tunnel", null])(
    "is loopback-only inside Your devices (%s)",
    async (channel) => {
      const request = vi.fn(async (method: string) =>
        method === "openclawId.people" ? { link: { linked: true, ownerDevices: [] } } : { channel },
      );
      const done = showOwnerDevicesDialog({
        client: { request } as unknown as GatewayBrowserClient,
      });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Your devices"));
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("openclawId.status", {}));
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          channel === "local_operator"
            ? "Use your recovery kit or another approved owner browser"
            : "This browser",
        ),
      );
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Approve a new device",
        ),
      ).toBe(false);
      expect(document.body.textContent?.includes("Reset owner access")).toBe(
        channel === "local_operator",
      );
      const close = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Close",
      );
      close?.click();
      await done;
    },
  );
});
