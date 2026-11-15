/* @vitest-environment jsdom */
import "../modal-dialog.tsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import * as confirmDialogs from "../confirm-dialog.ts";
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

// The device sign-in behind Link your profile; it has its own dialog and tests.
const showDeviceSignInDialog = vi.hoisted(() => vi.fn());
// mock-isolation: the device sign-in dialog is replaced so the setup dialog's outcome handling runs alone.
vi.mock("./device-sign-in-dialog.tsx", () => ({ showDeviceSignInDialog }));

// Click only enabled controls, so assertions follow the actual wizard gates.
async function click(label: string) {
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll("button")].findLast(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button, `enabled ${label} button`).toBeDefined();
    expect(button?.disabled).toBe(false);
    button!.click();
  });
}

// The relay step's state on the progress card.
const relayState = () =>
  document.querySelectorAll<HTMLElement>(".openclaw-id-steps__item")[3]?.dataset.state;

// Signs in this tab as `signedIn`, the way a completed sign-in publishes the account.
function signIn() {
  installSafeLocalStorageForTesting().setItem(
    "openclaw.openclawId.account",
    JSON.stringify(signedIn),
  );
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "openclaw.openclawId.account",
      newValue: JSON.stringify(signedIn),
    }),
  );
}

// Walks the name and recovery-kit steps, then waits for the completed progress card.
async function completeSetup() {
  await click("Continue");
  await vi.waitFor(() => expect(document.querySelector('input[type="checkbox"]')).not.toBeNull());
  (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  await click("Continue");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Your claw address"));
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
      // A relay that isn't up yet keeps its step running instead of warning at once.
      expect(relayState()).toBe(online ? "done" : "running");
      expect(document.body.textContent).not.toContain("Remote access is not connected yet");
      const warning = document.querySelector<HTMLButtonElement>(
        '.openclaw-id-steps__item[data-state="warning"] button',
      );
      expect(warning?.getAttribute("aria-label")).toContain(expected);
      const tooltip = document.getElementById(warning!.getAttribute("aria-describedby")!);
      expect(tooltip?.textContent).toContain("HTTP 503");
      expect(document.body.textContent).not.toMatch(/add an enrollment code/i);
      await click("Close");
      expect(await done).toBe(true);
    },
  );
});

describe("Make reachable over a personal sign-in", () => {
  afterEach(() => {
    cleanupSolid();
    keyEvents.length = 0;
    showDeviceSignInDialog.mockReset();
    localStorage.removeItem("openclaw.openclawId.account");
    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  });

  // A Gateway that answers setup, reporting `profileLink` at commit and `online` in turn for
  // each relay status read (the last answer repeats).
  function gateway(profileLink: string | null, online: boolean[] = [true]) {
    let reads = 0;
    return vi.fn(async (method: string, params: { action?: string }) => {
      if (method === "openclawId.status") {
        const relayOnline = online[Math.min(reads++, online.length - 1)];
        return { status: { state: "on", tunnel: { state: "running", relayOnline } } };
      }
      if (params.action === "account_link_code") {
        return { code: "synthetic-code" };
      }
      if (params.action === "commit") {
        return { publication: { state: "published" }, profileLink };
      }
      return { claw_id: "synthetic-claw", hostname: "studio-test.claws.test", available: true };
    });
  }

  const notice = () => document.querySelector(".openclaw-id-setup__profile");
  const pin = () =>
    document.querySelectorAll<HTMLElement>(".openclaw-id-steps__item")[1]?.dataset.state;
  const close = () =>
    document
      .querySelector("openclaw-modal-dialog")!
      .dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));

  it.each([
    { linkProfile: true, profileLink: "linked", expected: null, canLink: false },
    {
      linkProfile: true,
      profileLink: "sign_in_not_held",
      expected: "Sign in again to link it",
      canLink: true,
    },
    {
      linkProfile: true,
      profileLink: "not_admin",
      expected: "Link it in Settings → Profile",
      canLink: false,
    },
    {
      linkProfile: true,
      profileLink: "profile_linked",
      expected: "already linked to an OpenClaw ID",
      canLink: false,
    },
    { linkProfile: false, profileLink: null, expected: null, canLink: false },
  ])(
    "links the admin's profile at commit (linkProfile $linkProfile, result $profileLink)",
    async ({ linkProfile, profileLink, expected, canLink }) => {
      const request = gateway(profileLink);
      signIn();
      const done = showMakeReachableDialog({
        client: { request } as unknown as GatewayBrowserClient,
        loaderDomain: "claws.test",
        signedIn,
        linkProfile,
      });
      await completeSetup();
      const commit = request.mock.calls.find(([, params]) => params.action === "commit")?.[1];
      // The ID token leaves the browser only when the admin's setup links the profile.
      if (linkProfile) {
        expect(commit).toMatchObject({ idToken: "synthetic" });
      } else {
        expect(commit).not.toHaveProperty("idToken");
      }
      // The claw's access is set up either way; the profile link is a separate note.
      expect(pin()).toBe("done");
      if (expected) {
        expect(notice()?.textContent).toContain(expected);
      } else {
        expect(notice()).toBeNull();
      }
      const action = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Link your profile",
      );
      expect(Boolean(action)).toBe(canLink);
      await click(expected ? "Close" : "Done");
      expect(await done).toBe(true);
      expect(showDeviceSignInDialog).not.toHaveBeenCalled();
    },
  );

  it.each([
    { outcome: "linked", expected: null },
    { outcome: "linked_elsewhere", expected: "already linked to another profile" },
    { outcome: null, expected: "Sign in again to link it" },
  ])(
    "links the profile with a fresh sign-in after sign_in_not_held (outcome $outcome)",
    async ({ outcome, expected }) => {
      const linking = Promise.withResolvers<{ signedIn: unknown; link: string } | null>();
      showDeviceSignInDialog.mockReturnValueOnce(linking.promise);
      const request = gateway("sign_in_not_held");
      signIn();
      const done = showMakeReachableDialog({
        client: { request } as unknown as GatewayBrowserClient,
        loaderDomain: "claws.test",
        signedIn,
        linkProfile: true,
      });
      await completeSetup();
      await click("Link your profile");
      await vi.waitFor(() => expect(showDeviceSignInDialog).toHaveBeenCalledOnce());
      expect(showDeviceSignInDialog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ client: { request }, link: true }),
      );
      const action = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Link your profile",
      );
      expect(action?.disabled).toBe(true);
      // A closed sign-in dialog resolves null and keeps the note.
      linking.resolve(outcome === null ? null : { signedIn, link: outcome });
      if (expected) {
        await vi.waitFor(() => expect(notice()?.textContent).toContain(expected));
        close();
      } else {
        await vi.waitFor(() => expect(notice()).toBeNull());
        await click("Done");
      }
      expect(await done).toBe(true);
    },
  );

  it("ignores a profile link that finishes after setup closes", async () => {
    const linking = Promise.withResolvers<{ signedIn: unknown; link: string } | null>();
    showDeviceSignInDialog.mockReturnValueOnce(linking.promise);
    const request = gateway("sign_in_not_held");
    signIn();
    const done = showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
      signedIn,
      linkProfile: true,
    });
    await completeSetup();
    await click("Link your profile");
    await vi.waitFor(() => expect(showDeviceSignInDialog).toHaveBeenCalledOnce());
    await click("Close");
    expect(await done).toBe(true);
    linking.resolve({ signedIn, link: "linked" });
    await linking.promise;
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("keeps the note and offers the link again when the sign-in fails", async () => {
    showDeviceSignInDialog.mockRejectedValueOnce(new Error("Sign-in timed out. Try again."));
    const request = gateway("sign_in_not_held");
    signIn();
    const done = showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
      signedIn,
      linkProfile: true,
    });
    await completeSetup();
    await click("Link your profile");
    // The sign-in failure replaces the note, mapped like any other sign-in error.
    await vi.waitFor(() => expect(notice()?.textContent).toContain("Start sign-in again"));
    await click("Link your profile");
    await vi.waitFor(() => expect(showDeviceSignInDialog).toHaveBeenCalledTimes(2));
    close();
    expect(await done).toBe(true);
  });

  it("turns the relay step done once the relay comes up after the commit", async () => {
    const request = gateway("linked", [false, true]);
    signIn();
    const done = showMakeReachableDialog({
      client: { request } as unknown as GatewayBrowserClient,
      loaderDomain: "claws.test",
      signedIn,
      linkProfile: true,
    });
    await completeSetup();
    expect(relayState()).toBe("running");
    // The setup is done, so the dialog can close while the relay step still runs.
    expect(
      [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Done")
        ?.disabled,
    ).toBe(false);
    await vi.waitFor(() => expect(relayState()).toBe("done"), { timeout: 5_000 });
    expect(
      request.mock.calls.filter(([method]) => method === "openclawId.status").length,
    ).toBeGreaterThanOrEqual(2);
    await click("Done");
    expect(await done).toBe(true);
  });
});

describe("Make reachable preparation", () => {
  afterEach(() => {
    cleanupSolid();
    vi.restoreAllMocks();
    localStorage.removeItem("openclaw.openclawId.account");
    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.openclawId.account" }));
  });

  it.each([false, true])(
    "prepares once after account-code loading (manual fallback: %s)",
    async (manualCode) => {
      const preparations: ((value: unknown) => void)[] = [];
      const enrollment = Promise.withResolvers<{ code: string }>();
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
          return enrollment.promise;
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
      await vi.waitFor(() =>
        expect(document.querySelector("#openclaw-id-claw-name")).not.toBeNull(),
      );
      expect(document.querySelector("#openclaw-id-link-code")).toBeNull();
      expect(document.body.textContent).toContain("Signed in as owner@example.test.");
      if (manualCode) {
        enrollment.reject(new Error("Synthetic link-code failure"));
        const input = await vi.waitFor(() => {
          const field = document.querySelector<HTMLInputElement>("#openclaw-id-link-code");
          expect(field).not.toBeNull();
          return field!;
        });
        input.value = "synthetic-code";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        enrollment.resolve({ code: "synthetic-code" });
      }
      const next = await vi.waitFor(() => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Continue",
        );
        expect(button?.disabled).toBe(false);
        return button!;
      });
      if (manualCode) {
        document
          .querySelector("#openclaw-id-link-code")!
          .dispatchEvent(new Event("change", { bubbles: true }));
      }
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
      await vi.waitFor(() =>
        expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
      );
      expect(preparations).toHaveLength(1);
      const password = document.querySelector<HTMLInputElement>(
        'input[autocomplete="new-password"]',
      )!;
      vi.spyOn(confirmDialogs, "showConfirmDialog").mockRejectedValueOnce(
        new Error("Confirmation dialog could not load"),
      );
      await click("Cancel");
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent ?? "").toContain(
          "Could not confirm that setup finished",
        ),
      );
      expect(document.querySelector('input[autocomplete="new-password"]')).toBe(password);
      expect(password.value).toBe("synthetic kit");
      await click("Cancel");
      await click("Back");
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(document.querySelector('input[autocomplete="new-password"]')).not.toBeNull();
      document
        .querySelector("openclaw-modal-dialog")!
        .dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await click("Cancel");
      expect(await done).toBe(false);
    },
  );
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
