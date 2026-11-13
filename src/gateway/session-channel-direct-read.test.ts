import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), authority: vi.fn() }));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  listCanonicalUserChannelIdentities: mocks.list,
  prepareUserChannelIdentityAuthority: mocks.authority,
}));

import {
  prepareTelegramLinkedDirectReads,
  resolveTelegramSessionDirect,
} from "./session-channel-direct-read.js";

const identity = { channelId: "telegram", accountId: "default", senderId: "123" };
const key = "agent:editor:telegram:direct:123";
const entry = {
  delivery: {
    kind: "external" as const,
    context: {},
    route: { channel: "telegram", accountId: "default", target: { to: "telegram:123" } },
    origin: { provider: "telegram", chatType: "direct" as const },
  },
};
let current = true;
beforeEach(() => {
  vi.resetAllMocks();
  current = true;
  mocks.list.mockResolvedValue([{ profileId: "profile", identity }]);
  mocks.authority.mockResolvedValue({ linked: { profileId: "profile" }, isCurrent: () => current });
});

it("admits only the linked account and peer for base and canonical thread keys, and revokes immediately", async () => {
  const proof = await prepareTelegramLinkedDirectReads({
    profileId: "profile",
    qualifyAccount: () => true,
  });
  const thread = {
    delivery: { ...entry.delivery, route: { ...entry.delivery.route, thread: { id: 42 } } },
  };
  expect(
    (await prepareTelegramLinkedDirectReads({ profileId: "profile" })).canRead(key, entry),
  ).toBe(false);
  expect(proof.canRead(key, entry)).toBe(true);
  expect(proof.canRead("agent:editor:telegram:default:direct:123", entry)).toBe(true);
  expect(proof.canRead(`${key}:thread:123:42`, thread)).toBe(true);
  expect(
    proof.canRead(`${key}:thread:123:42`, {
      delivery: {
        ...thread.delivery,
        route: { ...thread.delivery.route, target: { to: "telegram:123:topic:42" } },
      },
    }),
  ).toBe(true);
  expect(
    proof.canRead("agent:editor:telegram:direct:999", {
      delivery: {
        ...entry.delivery,
        route: { ...entry.delivery.route, target: { to: "telegram:999" } },
      },
    }),
  ).toBe(false);
  expect(
    proof.canRead(key, {
      delivery: { ...entry.delivery, route: { ...entry.delivery.route, accountId: "other" } },
    }),
  ).toBe(false);
  const revision = proof.revisionKey();
  current = false;
  expect(proof.revisionKey()).not.toBe(revision);
  expect(proof.canRead(key, entry)).toBe(false);
});

it.each([
  ["agent:editor:telegram:other:direct:123", entry],
  ["agent:editor:telegram:direct:1234", entry],
  [
    `${key}:thread:999:42`,
    { delivery: { ...entry.delivery, route: { ...entry.delivery.route, thread: { id: 42 } } } },
  ],
  [`${key}:thread:123:42:extra`, entry],
  [`${key}:thread:123:42`, entry],
  [
    `${key}:thread:123:42`,
    { delivery: { ...entry.delivery, route: { ...entry.delivery.route, thread: { id: 43 } } } },
  ],
  [
    key,
    {
      delivery: { ...entry.delivery, origin: { provider: "telegram", chatType: "group" as const } },
    },
  ],
  [key, { createdVia: "operator" as const, ...entry }],
])("rejects malformed or inconsistent route %s", (sessionKey, row) => {
  expect(resolveTelegramSessionDirect(sessionKey, row)).toBeUndefined();
});

it("fails closed for another profile, stale links, failures and cancellation", async () => {
  mocks.authority.mockResolvedValueOnce({ linked: { profileId: "other" }, isCurrent: () => true });
  expect(
    (await prepareTelegramLinkedDirectReads({ profileId: "profile" })).canRead(key, entry),
  ).toBe(false);
  mocks.authority.mockRejectedValueOnce(new Error("unavailable"));
  expect(
    (await prepareTelegramLinkedDirectReads({ profileId: "profile" })).canRead(key, entry),
  ).toBe(false);
  const controller = new AbortController();
  const proof = await prepareTelegramLinkedDirectReads({
    profileId: "profile",
    signal: controller.signal,
    qualifyAccount: () => true,
  });
  expect(proof.canRead(key, entry)).toBe(true);
  controller.abort();
  expect(proof.canRead(key, entry)).toBe(false);
});

it("rejects mismatched or noncanonical linked identities without asking for authority", async () => {
  mocks.list.mockResolvedValue([
    { profileId: "other", identity },
    { profileId: "profile", identity: { ...identity, accountId: "DEFAULT" } },
    { profileId: "profile", identity: { ...identity, senderId: "0123" } },
  ]);
  expect(
    (await prepareTelegramLinkedDirectReads({ profileId: "profile" })).canRead(key, entry),
  ).toBe(false);
  expect(mocks.authority).not.toHaveBeenCalled();
});
