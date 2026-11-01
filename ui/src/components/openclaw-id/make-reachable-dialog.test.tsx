/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showMakeReachableDialog } from "./make-reachable-dialog.tsx";

// Replace browser key custody, not the dialog's linking sequence or publication messages.
vi.mock("../../lib/openclaw-id/device-key.ts", () => ({
  generateOwnerDeviceKey: async () => ({ signer: {}, pair: {} }),
  saveOwnerDeviceKey: async () => {},
}));
vi.mock("../../lib/openclaw-id/link.ts", () => ({
  linkCodePageUrl: () => "https://claws.test/link",
  createOpenClawIdCeremony: () => ({
    createKit: async () => ({ text: "synthetic kit", rootFingerprint: "synthetic fingerprint" }),
    sign: async () => ({}),
    discard: () => {},
  }),
}));

// Click only enabled controls, so assertions follow the actual wizard gates.
async function click(label: string) {
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    button!.click();
  });
}

describe("Make reachable publication outcome", () => {
  afterEach(cleanupSolid);

  it("shows the failure cause and automatic retry to a signed-in owner, not enrollment guidance", async () => {
    const request = vi.fn(async (method: string, params: { action?: string }) => {
      if (method === "openclawId.status") {
        return { status: { state: "on", tunnel: { state: "running", relayOnline: true } } };
      }
      if (params.action === "account_link_code") {
        return { code: "synthetic-code" };
      }
      if (params.action === "commit") {
        return { publication: { state: "failed", code: "unavailable", message: "HTTP 503" } };
      }
      return { claw_id: "synthetic-claw", hostname: "studio-test.claws.test", available: true };
    });
    const done = showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
      signedIn: {
        sub: "owner",
        email: "owner@example.test",
        name: null,
        exp: 2_000_000_000,
        idToken: "synthetic",
      },
    });
    await click("Continue");
    await click("Create owner key");
    await vi.waitFor(() => expect(document.querySelector('input[type="checkbox"]')).not.toBeNull());
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await click("Continue");
    await vi.waitFor(() => expect(document.body.textContent).toContain("HTTP 503"));
    expect(document.body.textContent).toContain("retries automatically");
    expect(document.body.textContent).not.toMatch(/add an enrollment code/i);
    await click("Done");
    expect(await done).toBe(true);
  });
});
