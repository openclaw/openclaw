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

describe("Your devices actions", () => {
  afterEach(() => {
    cleanupSolid();
  });
  it.each(["local_operator", "tunnel", null])(
    "shows devices and security details without management controls when keyless (%s)",
    async (channel) => {
      const request = vi.fn(async (method: string) =>
        method === "openclawId.people"
          ? {
              link: {
                linked: true,
                rootPub: `ed25519:${"11".repeat(32)}`,
                ownerDevices: [
                  { devicePub: "ed25519:other", label: "Laptop", peerKeys: [], approvedBy: "root" },
                ],
              },
            }
          : { channel },
      );
      const done = showOwnerDevicesDialog({
        client: { request } as unknown as GatewayBrowserClient,
      });
      await vi.waitFor(() => expect(document.body.textContent).toContain("Your devices"));
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("openclawId.status", {}));
      const security = () => document.querySelector<HTMLButtonElement>("button[aria-expanded]");
      await vi.waitFor(() => expect(security()).not.toBeNull());
      expect(document.querySelector<HTMLElement>('[role="list"]')?.tabIndex).toBe(0);
      expect(document.querySelector('[role="listitem"]')?.textContent).toContain("Laptop");
      expect(document.querySelector('[role="note"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Remove access");
      const details = document.getElementById(security()!.getAttribute("aria-controls")!)!;
      expect(details.hidden).toBe(true);
      security()!.click();
      await vi.waitFor(() => expect(details.hidden).toBe(false));
      expect(details.textContent).toContain("Recovery kit ID");
      expect(details.querySelector("dd")?.textContent).toMatch(/\S+/);
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Approve a new device",
        ),
      ).toBe(false);
      expect(document.body.textContent).not.toContain("Reset owner access");
      const close = Array.from(document.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Close",
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
  it("names cascade removals and keeps rows until the Gateway confirms removal", async () => {
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
    const phonePub = `ed25519:${"11".repeat(32)}`;
    let ownerDevices = [
      device("Phone", "fp:Laptop", phonePub),
      device("Tablet", "fp:Phone"),
      device("Watch", "fp:gone"),
      device("Laptop", "root", own),
    ];
    const submission = Promise.withResolvers<void>();
    const request = vi.fn(async (method: string) => {
      if (method === "openclawId.authority") {
        await submission.promise;
        ownerDevices = ownerDevices.filter((entry) => !["Phone", "Tablet"].includes(entry.label));
        return { status: "applied" };
      }
      return method === "openclawId.people"
        ? { link: { linked: true, clawId: "claw-1", seq: 1, ownerDevices } }
        : { channel: "tunnel" };
    });
    // Skip browser-only animation; jsdom exercises confirmed list reconciliation.
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const done = showOwnerDevicesDialog({
      client: { request } as unknown as GatewayBrowserClient,
    });
    const phone = () =>
      Array.from(document.querySelectorAll('[role="listitem"]')).find((row) =>
        row.querySelector(".openclaw-id-devices__label")?.textContent?.startsWith("Phone"),
      );
    const button = (root: ParentNode | undefined, name: string) =>
      Array.from(root?.querySelectorAll("button") ?? []).find(
        (candidate) =>
          (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name,
      );
    await vi.waitFor(() => expect(button(phone(), "Remove access")).toBeDefined());
    expect(document.querySelector('[role="listitem"]')?.textContent).toContain("Laptop");
    expect(document.body.textContent).toContain("Approved with the recovery kit");
    expect(document.body.textContent).toContain("Approved by Laptop");
    expect(document.body.textContent).toContain("Approved by a device that was removed");
    button(phone(), "Remove access")?.click();
    const watch = Array.from(document.querySelectorAll('[role="listitem"]')).find((row) =>
      row.textContent?.startsWith("Watch"),
    );
    button(watch, "Remove access")?.click();
    await vi.waitFor(() => expect(button(watch, "Cancel")).toBeDefined());
    expect(button(phone(), "Cancel")).toBeUndefined();
    button(phone(), "Remove access")?.click();
    await vi.waitFor(() =>
      expect(phone()?.querySelector('[role="note"]')?.textContent).toBe(
        "Phone loses access now, and so do the devices it approved: Tablet. To restore access, approve them from another device or use your recovery kit.",
      ),
    );
    expect(phone()?.querySelector('[role="note"] p:last-child')?.textContent).toBe(
      "To restore access, approve them from another device or use your recovery kit.",
    );
    button(phone(), "Remove access for Phone")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", expect.anything()),
    );
    expect(phone()).toBeDefined();
    expect(button(phone(), "Remove access for Phone")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Tablet");
    submission.resolve();
    await vi.waitFor(() => expect(phone()).toBeUndefined());
    expect(document.body.textContent).not.toContain("Tablet");
    expect(document.body.textContent).toContain("Watch");
    button(document, "Close")?.click();
    await done;
  });
});
