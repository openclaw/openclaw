import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { showRegenerateOwnerKeyDialog } from "./regenerate-owner-key-dialog.tsx";

vi.mock("../../lib/openclaw-id/device-key.ts", () => ({
  generateOwnerDeviceKey: async () => ({ signer: {}, pair: {} }),
  saveOwnerDeviceKey: async () => {},
}));
vi.mock("../../lib/openclaw-id/link.ts", () => ({
  createOpenClawIdCeremony: () => ({
    createKit: async () => ({ text: "synthetic kit", rootFingerprint: "synthetic fingerprint" }),
    signRegeneration: async () => ({}),
    discard: () => {},
  }),
}));

afterEach(cleanupSolid);

// Exercise the existing wizard rather than replacing its submit callback.
async function click(label: string) {
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button?.disabled).toBe(false);
    button!.click();
  });
}

it.each([false, true])(
  "reset kit discards or submits explicitly (continue: %s)",
  async (continueReset) => {
    const request = vi.fn(async () => ({ hostname: "demo-e61zr.claws.test" }));
    const done = showRegenerateOwnerKeyDialog({
      // SAFETY: the dialog only uses request; key custody is replaced above.
      client: { request } as unknown as GatewayBrowserClient,
      signedIn: {
        sub: "owner",
        email: "owner@example.test",
        name: null,
        exp: 2_000_000_000,
        idToken: "synthetic",
      },
    });
    await click("Regenerate");
    await vi.waitFor(() =>
      expect(document.querySelector('input[autocomplete="new-password"]')).not.toBeNull(),
    );
    const password = document.querySelector<HTMLInputElement>(
      'input[autocomplete="new-password"]',
    )!;
    const username = document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
    expect(username.value).toBe("owner@example.test");
    expect(password.value).toBe("synthetic kit");
    expect(request).toHaveBeenCalledTimes(1);
    const form = password.form!;
    const submitted = vi.fn();
    form.addEventListener("submit", submitted);
    if (continueReset) {
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      await click("Replace owner key");
      await click("Done");
      expect(submitted).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
    } else {
      await click("Cancel");
      expect(submitted).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    }
    form.removeEventListener("submit", submitted);
    expect(await done).toBe(continueReset);
    expect(username.value).toBe("");
    expect(password.value).toBe("");
  },
);
