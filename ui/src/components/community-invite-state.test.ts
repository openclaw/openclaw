/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCommunityInviteContext } from "./community-invite-state.test-support.ts";
import * as invite from "./community-invite-state.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  invite.dismissCommunityInvite();
  localStorage.clear();
});

it("treats a new browser origin as undismissed without writing a marker", () => {
  expect(invite.isCommunityInviteDismissed()).toBe(false);
  expect(localStorage.getItem(invite.COMMUNITY_INVITE_KEY)).toBeNull();
});

it.each(["", "{", '{"dismissedAtMs":1760000001000}'])(
  "keeps stored state %j dismissed",
  (value) => {
    localStorage.setItem(invite.COMMUNITY_INVITE_KEY, value);
    expect(invite.isCommunityInviteDismissed()).toBe(true);
  },
);

it("treats unreadable browser storage as dismissed", () => {
  vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
    throw new Error("storage unavailable");
  });
  expect(invite.isCommunityInviteDismissed()).toBe(true);
});

it("persists dismissal in the existing browser-origin format", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_760_000_001_000);
  expect(invite.dismissCommunityInvite()).toEqual({ ok: true, value: undefined });
  expect(JSON.parse(localStorage.getItem(invite.COMMUNITY_INVITE_KEY) ?? "null")).toEqual({
    dismissedAtMs: 1_760_000_001_000,
  });
  expect(invite.isCommunityInviteDismissed()).toBe(true);
});

it("retains an in-memory dismissal after a failed save", () => {
  vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(invite.dismissCommunityInvite()).toEqual({ ok: false, error: "storage-unavailable" });
  expect(localStorage.getItem(invite.COMMUNITY_INVITE_KEY)).toBeNull();
  expect(invite.isCommunityInviteDismissed()).toBe(true);
});

it.each([
  [0, false],
  [1, false],
  [2, false],
  [3, true],
])("with %i prompted sessions, reaches eligibility: %s", async (used, eligible) => {
  const fixture = createCommunityInviteContext({ used });
  const reached = vi.fn();
  const stop = invite.observeCommunityInviteSessionUse(fixture.context, reached);
  await fixture.settled();
  expect(fixture.reads).toBe(1);
  expect(reached).toHaveBeenCalledTimes(Number(eligible));
  // Eligibility is final for this page; the bounded observation retires with it.
  expect(fixture.observing()).toBe(!eligible);
  expect(fixture.queries).toEqual([
    {
      source: "sidebar",
      promptedByMe: true,
      archivedFilter: "all",
      limit: 1,
      rowMode: "compact",
      includeDerivedTitles: false,
      includeLastMessage: false,
      includeGlobal: false,
      includeUnknown: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      excludeDock: true,
    },
  ]);
  stop();
  expect(fixture.observing()).toBe(false);
});

it("appears in place when a later Gateway read reaches the third session", async () => {
  const fixture = createCommunityInviteContext({ used: 2 });
  const reached = vi.fn();
  invite.observeCommunityInviteSessionUse(fixture.context, reached);
  await fixture.settled();
  fixture.publish({ used: 2 });
  expect(reached).not.toHaveBeenCalled();
  fixture.publish({ used: 3 });
  expect(reached).toHaveBeenCalledOnce();
  expect(fixture.observing()).toBe(false);
});

it("keeps the invitation hidden for retained, failed, or disconnected reads", async () => {
  const retained = createCommunityInviteContext({ used: 2, retained: 9 });
  const failed = createCommunityInviteContext({ used: "failed" });
  const offline = createCommunityInviteContext({ used: 3, connected: false });
  const reached = vi.fn();
  for (const fixture of [retained, failed, offline]) {
    invite.observeCommunityInviteSessionUse(fixture.context, reached);
  }
  await Promise.all([retained.settled(), failed.settled()]);
  expect([retained.reads, failed.reads]).toEqual([1, 1]);
  expect(offline.queries).toEqual([]);
  expect(reached).not.toHaveBeenCalled();
  // A connection that becomes available is read through the same bounded query.
  offline.connect();
  await offline.settled();
  expect(reached).toHaveBeenCalledOnce();
});
