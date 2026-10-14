/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";

let invite: typeof import("./community-invite-state.ts");

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("sessionStorage", createStorageMock());
  invite = await import("./community-invite-state.ts");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("allows a new browser origin without writing a marker", () => {
  expect(invite.isCommunityInviteEligible()).toBe(true);
  expect(localStorage.getItem(invite.COMMUNITY_INVITE_KEY)).toBeNull();
});

it.each(["", "{", '{"dismissedAtMs":1760000001000}'])(
  "suppresses the invitation for stored state %j",
  (value) => {
    localStorage.setItem(invite.COMMUNITY_INVITE_KEY, value);
    expect(invite.isCommunityInviteEligible()).toBe(false);
  },
);

it("hides the invitation when browser storage cannot be read", () => {
  vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
    throw new Error("storage unavailable");
  });
  expect(invite.isCommunityInviteEligible()).toBe(false);
});

it("persists dismissal in the existing browser-origin format", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_760_000_001_000);
  expect(invite.dismissCommunityInvite()).toEqual({ ok: true, value: undefined });
  expect(JSON.parse(localStorage.getItem(invite.COMMUNITY_INVITE_KEY) ?? "null")).toEqual({
    dismissedAtMs: 1_760_000_001_000,
  });
  expect(invite.isCommunityInviteEligible()).toBe(false);
});

it("retains an in-memory dismissal after a failed save", () => {
  vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(invite.dismissCommunityInvite()).toEqual({ ok: false, error: "storage-unavailable" });
  expect(localStorage.getItem(invite.COMMUNITY_INVITE_KEY)).toBeNull();
  expect(invite.isCommunityInviteEligible()).toBe(false);
});

it("retains dismissal across document reloads when permanent storage is full", async () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(invite.dismissCommunityInvite()).toEqual({ ok: false, error: "storage-unavailable" });

  vi.resetModules();
  invite = await import("./community-invite-state.ts");
  expect(localStorage.getItem(invite.COMMUNITY_INVITE_KEY)).toBeNull();
  expect(invite.isCommunityInviteEligible()).toBe(false);
});

it("persists permanently even when tab storage rejects writes", async () => {
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(invite.dismissCommunityInvite()).toEqual({ ok: true, value: undefined });

  vi.resetModules();
  invite = await import("./community-invite-state.ts");
  expect(invite.isCommunityInviteEligible()).toBe(false);
});
