/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showOwnerDevicesDialog } from "./owner-devices-dialog.tsx";

// Dialogs open only while the enabled feature's lifetime runs.
let endFeature = () => {};
beforeEach(() => {
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => endFeature());

// Empty owner-device state avoids keys and exercises the production dialog gate.
describe("Your devices actions", () => {
  afterEach(() => {
    cleanupSolid();
  });
  it.each(["local_operator", "tunnel", null])(
    "offers no owner reset on any channel (%s)",
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
      expect(document.body.textContent).not.toContain("Reset owner access");
      const close = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Close",
      );
      close?.click();
      await done;
    },
  );
});

describe("approved by", () => {
  afterEach(() => {
    cleanupSolid();
  });
  it("shows who approved each device", async () => {
    const device = (name: string, approvedBy: string) => ({
      devicePub: `ed25519:${name}`,
      deviceFp: `fp:${name}`,
      label: name,
      peerKeys: [],
      approvedBy,
      lastSeen: 0,
      cert: {},
    });
    const ownerDevices = [
      device("Laptop", "root"),
      device("Phone", "fp:Laptop"),
      device("Tablet", "fp:gone"),
    ];
    const request = vi.fn(async (method: string) =>
      method === "openclawId.people"
        ? { link: { linked: true, ownerDevices } }
        : { channel: "tunnel" },
    );
    const done = showOwnerDevicesDialog({
      client: { request } as unknown as GatewayBrowserClient,
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Phone"));
    expect(document.body.textContent).toContain("Approved with the recovery kit");
    expect(document.body.textContent).toContain("Approved by Laptop");
    expect(document.body.textContent).toContain("Approved by a device that was removed");
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Close")
      ?.click();
    await done;
  });
});
