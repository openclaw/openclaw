/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEd25519PublicKey } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureOwnerDeviceSigner } from "../../lib/openclaw-id/device-key.ts";
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
    vi.unstubAllGlobals();
  });
  it("shows who approved each device and names the removed one in its preview", async () => {
    // This browser holds a real owner key for the claw, so it may remove the others.
    vi.stubGlobal("indexedDB", new IDBFactory());
    const own = formatEd25519PublicKey((await ensureOwnerDeviceSigner("claw-1")).publicKey);
    const device = (name: string, approvedBy: string, devicePub = `ed25519:${name}`) => ({
      devicePub,
      deviceFp: `fp:${name}`,
      label: name,
      peerKeys: [],
      approvedBy,
      lastSeen: 0,
      cert: {},
    });
    const ownerDevices = [
      device("Laptop", "root", own),
      device("Phone", "fp:Laptop"),
      device("Tablet", "fp:Phone"),
      device("Watch", "fp:gone"),
    ];
    const request = vi.fn(async (method: string) =>
      method === "openclawId.people"
        ? { link: { linked: true, clawId: "claw-1", ownerDevices } }
        : { channel: "tunnel" },
    );
    const done = showOwnerDevicesDialog({
      client: { request } as unknown as GatewayBrowserClient,
    });
    const phone = () =>
      Array.from(document.querySelectorAll('[role="listitem"]')).find((row) =>
        row.querySelector(".openclaw-id-devices__label")?.textContent?.startsWith("Phone"),
      );
    const button = (root: ParentNode | undefined, name: string) =>
      Array.from(root?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent?.trim() === name,
      );
    await vi.waitFor(() => expect(button(phone(), "Remove access")).toBeDefined());
    expect(document.body.textContent).toContain("Approved with the recovery kit");
    expect(document.body.textContent).toContain("Approved by Laptop");
    expect(document.body.textContent).toContain("Approved by a device that was removed");
    button(phone(), "Remove access")?.click();
    await vi.waitFor(() =>
      expect(phone()?.querySelector('[role="note"]')?.textContent).toBe(
        "Phone loses access now, and so do the devices it approved: Tablet. To restore access, approve them from another device or use your recovery kit.",
      ),
    );
    button(document, "Close")?.click();
    await done;
  });
});
