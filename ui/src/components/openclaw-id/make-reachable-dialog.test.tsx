/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import { showMakeReachableDialog } from "./make-reachable-dialog.tsx";

const signedIn = {
  sub: "owner",
  email: "owner@example.test",
  name: null,
  exp: 2_000_000_000,
  idToken: "synthetic",
};

// Dialogs open only while the enabled feature's lifetime runs.
let endFeature = () => {};
beforeEach(() => {
  endFeature = startOpenClawIdFeatureLifetime();
});
afterEach(() => endFeature());

// Records when the owner device key is stored and announced, relative to the commit.
const keyEvents = vi.hoisted(() => [] as string[]);
// Replace browser key custody, not the dialog's linking sequence or publication messages.
// mock-isolation: key generation and the root ceremony are replaced so the dialog's step flow runs deterministically.
vi.mock("../../lib/openclaw-id/device-key.ts", () => ({
  ensureOwnerDeviceSigner: async () => {
    keyEvents.push("stored");
    return {};
  },
  announceOwnerDeviceKey: () => keyEvents.push("announced"),
}));
// mock-isolation: key generation and the root ceremony are replaced so the dialog's step flow runs deterministically.
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
    const button = [...document.querySelectorAll("button")].findLast(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    button!.click();
  });
}

describe("Make reachable publication outcome", () => {
  afterEach(() => {
    cleanupSolid();
    keyEvents.length = 0;
    localStorage.removeItem("openclaw.openclawId.account");
    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  });

  it.each([
    { code: "unavailable", retryable: true, expected: "will keep trying", online: true },
    { code: "internal", retryable: true, expected: "will keep trying", online: true },
    {
      code: "registration_mismatch",
      retryable: false,
      expected: "does not match the saved ownership details",
      online: false,
    },
    {
      code: "unavailable",
      retryable: false,
      expected: "Remote access setup could not finish",
      online: true,
    },
  ])(
    "maps publication $code (retryable $retryable) without claiming readiness",
    async ({ code, retryable, expected, online }) => {
      const request = vi.fn(async (method: string, params: { action?: string }) => {
        if (method === "openclawId.status") {
          return { status: { state: "on", tunnel: { state: "running", relayOnline: online } } };
        }
        if (params.action === "account_link_code") {
          return { code: "synthetic-code" };
        }
        if (params.action === "commit") {
          keyEvents.push("commit");
          return {
            publication: {
              state: "failed",
              code,
              message: "HTTP 503",
              retryable,
            },
          };
        }
        return { claw_id: "synthetic-claw", hostname: "studio-test.claws.test", available: true };
      });
      const storage = installSafeLocalStorageForTesting();
      storage.setItem("openclaw.openclawId.account", JSON.stringify(signedIn));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "openclaw.openclawId.account",
          newValue: JSON.stringify(signedIn),
        }),
      );
      const done = showMakeReachableDialog({
        client: { request } as unknown as GatewayBrowserClient,
        loaderDomain: "claws.test",
        signedIn,
      });
      await click("Continue");
      await vi.waitFor(() =>
        expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
      );
      const password = document.querySelector<HTMLInputElement>(
        'input[autocomplete="new-password"]',
      )!;
      expect(password.value).toBe("synthetic kit");
      expect(request.mock.calls.some(([, params]) => params.action === "commit")).toBe(false);
      const form = password.form!;
      const submitted = vi.fn();
      form.addEventListener("submit", submitted);
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
      await click("Continue");
      await vi.waitFor(() => expect(document.body.textContent).toContain("HTTP 503"));
      // The admitted device key is stored before the irreversible commit is sent.
      expect(keyEvents).toEqual(["stored", "commit", "announced"]);
      expect(submitted).toHaveBeenCalledOnce();
      form.removeEventListener("submit", submitted);
      expect(password.value).toBe("");
      expect(document.body.textContent).toContain(expected);
      expect(document.querySelectorAll(".openclaw-id-steps li")).toHaveLength(4);
      if (online && !retryable) {
        expect(document.body.textContent).not.toContain("will keep trying");
      }
      if (!online) {
        expect(document.body.textContent).toContain("Remote access is not connected yet");
      }
      const details = [...document.querySelectorAll("details")].find((item) =>
        item.textContent?.includes("HTTP 503"),
      );
      expect(details?.open).toBe(false);
      expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
      expect(document.body.textContent).not.toMatch(/add an enrollment code/i);
      await click("Done");
      expect(await done).toBe(true);
    },
  );
});

describe("Make reachable preparation", () => {
  afterEach(() => {
    cleanupSolid();
    localStorage.removeItem("openclaw.openclawId.account");
    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  });

  it("checks the default name with the account's code, then asks for one preparation", async () => {
    const preparations: ((value: unknown) => void)[] = [];
    const request = vi.fn((method: string, params: { action?: string }) => {
      if (method === "openclawId.status") {
        return Promise.resolve({ status: { state: "on", tunnel: { state: "running" } } });
      }
      if (params.action === "prepare") {
        return new Promise((resolve) => {
          preparations.push(resolve);
        });
      }
      if (params.action === "account_link_code") {
        return Promise.resolve({ code: "synthetic-code" });
      }
      return Promise.resolve({ hostname: "studio-test.claws.test", available: true });
    });
    installSafeLocalStorageForTesting().setItem(
      "openclaw.openclawId.account",
      JSON.stringify(signedIn),
    );
    // The link code is requested only for the account this tab has published.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "openclaw.openclawId.account",
        newValue: JSON.stringify(signedIn),
      }),
    );
    const done = showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
      signedIn,
    });
    const next = await vi.waitFor(() => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Continue",
      );
      expect(button?.disabled).toBe(false);
      return button!;
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "openclawId.authority",
        expect.objectContaining({ action: "check_name", enrollmentCode: "synthetic-code" }),
      ),
    );
    next.click();
    next.click();
    expect(preparations).toHaveLength(1);
    preparations[0]!({ claw_id: "synthetic-claw", hostname: "studio-test.claws.test" });
    await vi.waitFor(() => expect(document.querySelector('input[type="checkbox"]')).not.toBeNull());
    expect(preparations).toHaveLength(1);
    await click("Cancel");
    await click("Back");
    expect(document.querySelector('input[autocomplete="new-password"]')).not.toBeNull();
    document
      .querySelector("openclaw-modal-dialog")!
      .dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await click("Cancel");
    expect(await done).toBe(false);
  });
});

describe("Make reachable and the Labs switch", () => {
  afterEach(() => cleanupSolid());

  it("opens nothing while the feature is off", async () => {
    endFeature();
    const request = vi.fn();
    const linked = await showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
    });
    expect(linked).toBe(false);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("closes an open dialog when the feature turns off", async () => {
    const done = showMakeReachableDialog({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
    });
    await vi.waitFor(() => expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull());
    endFeature();
    expect(await done).toBe(false);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
