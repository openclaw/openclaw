/* @vitest-environment jsdom */
// Link reuses this browser's held OpenClaw ID sign-in and falls back to one device sign-in only
// when there is none or the Gateway cannot reuse it (OCF-530).
import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

const dialog = vi.hoisted(() => ({
  show: vi.fn(async () => ({ signedIn: {}, link: "linked" as const })),
}));
// mock-isolation: the dialog has its own tests; here it only records that a device sign-in began.
vi.mock("../../components/openclaw-id/device-sign-in-dialog.tsx", () => ({
  showDeviceSignInDialog: dialog.show,
}));

// Built from the module instance link-profile.ts loaded (modules reset per case).
async function refusal(code: string) {
  const { GatewayRequestError } = await import("../../api/gateway-connect-errors.ts");
  return new GatewayRequestError({ code: "INVALID_REQUEST", message: code, details: { code } });
}

// account.ts reads the stored account when it loads, so each case loads it afresh.
async function linkWith(stored: { exp: number } | null, request: GatewayBrowserClient["request"]) {
  localStorage.clear();
  if (stored) {
    localStorage.setItem(
      "openclaw.openclawId.account",
      JSON.stringify({
        sub: "acct",
        email: "josh@id.test",
        name: null,
        idToken: "held",
        ...stored,
      }),
    );
  }
  vi.resetModules();
  const { linkOpenClawIdToProfile } = await import("./link-profile.ts");
  return await linkOpenClawIdToProfile({ request } as unknown as GatewayBrowserClient);
}

const fresh = () => ({ exp: Math.floor(Date.now() / 1000) + 3600 });

beforeEach(() => {
  dialog.show.mockClear();
});

it("links the held sign-in without a device code", async () => {
  const request = vi.fn(async () => ({ link: "linked_elsewhere" }));
  expect(await linkWith(fresh(), request as never)).toBe("linked_elsewhere");
  expect(request).toHaveBeenCalledExactlyOnceWith("openclawId.account", {
    action: "link_held",
    idToken: "held",
  });
  expect(dialog.show).not.toHaveBeenCalled();
});

it("falls back to one device sign-in without a held, unexpired sign-in or when it is not held", async () => {
  const request = vi.fn(async () => {
    throw await refusal("sign_in_not_held");
  });
  expect(await linkWith(null, request as never)).toBe("linked");
  expect(await linkWith({ exp: Math.floor(Date.now() / 1000) + 30 }, request as never)).toBe(
    "linked",
  );
  expect(request).not.toHaveBeenCalled();
  expect(await linkWith(fresh(), request as never)).toBe("linked");
  expect(request).toHaveBeenCalledOnce();
  expect(dialog.show).toHaveBeenCalledTimes(3);
  expect(dialog.show).toHaveBeenCalledWith(expect.objectContaining({ link: true }));
});

it("reports any other refusal instead of starting a device sign-in", async () => {
  const request = vi.fn(async () => {
    throw await refusal("not_personal_connection");
  });
  await expect(linkWith(fresh(), request as never)).rejects.toMatchObject({
    details: { code: "not_personal_connection" },
  });
  expect(dialog.show).not.toHaveBeenCalled();
});

it("does not start a device sign-in when the user signed out while the Gateway answered", async () => {
  const request = vi.fn(async () => {
    localStorage.removeItem("openclaw.openclawId.account");
    localStorage.setItem("openclaw.openclawId.signedOut", "later");
    throw await refusal("sign_in_not_held");
  });
  await expect(linkWith(fresh(), request as never)).rejects.toThrow("signed out");
  expect(dialog.show).not.toHaveBeenCalled();
});
