import { scheduler } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const check = vi.fn();
  const plugin = { directory: { isGroupMember: check } };
  return {
    check,
    plugin,
    registration: vi.fn(() => ({ plugin })),
    list: vi.fn(),
    authority: vi.fn(),
  };
});
vi.mock("../channels/plugins/registry.js", () => ({
  resolveChannelPluginRegistration: mocks.registration,
}));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  listCanonicalUserChannelIdentities: mocks.list,
  prepareUserChannelIdentityAuthority: mocks.authority,
}));

import {
  prepareTelegramGroupMembership,
  prepareTelegramGroupMemberships,
} from "./session-channel-membership.js";

const request = { cfg: {}, profileId: "profile", accountId: "bot", groupId: "-123" };
const identity = { channelId: "telegram", accountId: "bot", senderId: "123456" };
let current = true;

beforeEach(() => {
  vi.clearAllMocks();
  current = true;
  mocks.registration.mockReturnValue({ plugin: mocks.plugin });
  mocks.list.mockResolvedValue([{ profileId: "profile", identity }]);
  mocks.authority.mockResolvedValue({ linked: { profileId: "profile" }, isCurrent: () => current });
  mocks.check.mockResolvedValue(true);
});

it("checks the linked numeric identity against the exact bot and group, revoking on unlink", async () => {
  const proof = await prepareTelegramGroupMembership(request);
  expect(proof?.isCurrent()).toBe(true);
  expect(mocks.check).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "bot",
      groupId: "-123",
      memberId: "123456",
    }),
  );
  current = false;
  expect(proof?.isCurrent()).toBe(false);
});

it.each([false, null])("does not grant an unconfirmed membership (%s)", async (result) => {
  mocks.check.mockResolvedValue(result);
  expect(await prepareTelegramGroupMembership(request)).toBeUndefined();
});

it("does not check an identity linked to a different bot account", async () => {
  mocks.list.mockResolvedValue([
    { profileId: "profile", identity: { ...identity, accountId: "other" } },
  ]);
  expect(await prepareTelegramGroupMembership(request)).toBeUndefined();
  expect(mocks.check).not.toHaveBeenCalled();
});

it("fails closed when the provider fails or the link is revoked during the request", async () => {
  mocks.check.mockRejectedValueOnce(new Error("unavailable"));
  expect(await prepareTelegramGroupMembership(request)).toBeUndefined();
  mocks.check.mockImplementationOnce(async () => {
    current = false;
    return true;
  });
  expect(await prepareTelegramGroupMembership(request)).toBeUndefined();
});

it("checks one group once per request even when it has many topics", async () => {
  const facts = await prepareTelegramGroupMemberships({
    cfg: request.cfg,
    profileId: request.profileId,
    groups: Array.from({ length: 24 }, () => ({ accountId: "bot", groupId: "-123" })),
  });
  expect(facts.get(JSON.stringify(["bot", "-123"]))?.isCurrent()).toBe(true);
  expect(mocks.check).toHaveBeenCalledTimes(1);
  await prepareTelegramGroupMemberships({
    cfg: request.cfg,
    profileId: request.profileId,
    groups: [{ accountId: "bot", groupId: "-123" }],
  });
  expect(mocks.check).toHaveBeenCalledTimes(2);
});

it("bounds concurrent checks and returns no grants when the request aborts", async () => {
  const controller = new AbortController();
  const begun: number[] = [];
  let started!: () => void;
  const fourStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.check.mockImplementation(async () => {
    begun.push(1);
    if (begun.length === 4) {
      started();
    }
    await new Promise<void>(() => {});
    return true;
  });
  const pending = prepareTelegramGroupMemberships({
    cfg: request.cfg,
    profileId: request.profileId,
    groups: Array.from({ length: 12 }, (_, index) => ({
      accountId: "bot",
      groupId: `-${index + 1}`,
    })),
    signal: controller.signal,
  });
  await fourStarted;
  expect(begun).toHaveLength(4);
  controller.abort();
  expect((await pending).size).toBe(0);
  expect(begun).toHaveLength(4);
});

it("does not admit a late identity result after cancellation", async () => {
  const controller = new AbortController();
  let finish!: (links: Array<{ profileId: string; identity: typeof identity }>) => void;
  let started!: () => void;
  const pendingRead = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.list.mockImplementation((_profile, options: { signal: AbortSignal }) => {
    expect(options.signal.aborted).toBe(false);
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = prepareTelegramGroupMemberships({
    cfg: request.cfg,
    profileId: request.profileId,
    groups: [{ accountId: "bot", groupId: "-123" }],
    signal: controller.signal,
  });
  await pendingRead;
  controller.abort();
  expect((await pending).size).toBe(0);
  finish([{ profileId: "profile", identity }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.authority).not.toHaveBeenCalled();
  expect(mocks.check).not.toHaveBeenCalled();
});

it("keeps completed positive facts when the batch I/O deadline aborts a sibling check", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    expect(milliseconds).toBe(5_000);
    return deadline.signal;
  });
  const requestController = new AbortController();
  const fastGroup = { accountId: "bot", groupId: "-fast" };
  const slowGroup = { accountId: "bot", groupId: "-slow" };
  let finishSlow!: (member: boolean) => void;
  let slowStarted!: () => void;
  const slowCheckStarted = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  mocks.check.mockImplementation(async (params: { groupId: string }) => {
    if (params.groupId === fastGroup.groupId) {
      return true;
    }
    slowStarted();
    return new Promise<boolean>((resolve) => {
      finishSlow = resolve;
    });
  });

  try {
    const pending = prepareTelegramGroupMemberships({
      cfg: request.cfg,
      profileId: request.profileId,
      groups: [fastGroup, slowGroup],
      signal: requestController.signal,
    });
    await slowCheckStarted;
    await scheduler.yield();
    deadline.abort();
    const facts = await pending;

    expect(timeout).toHaveBeenCalledOnce();
    expect(facts.get(JSON.stringify([fastGroup.accountId, fastGroup.groupId]))?.isCurrent()).toBe(
      true,
    );
    expect(facts.has(JSON.stringify([slowGroup.accountId, slowGroup.groupId]))).toBe(false);

    finishSlow(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(facts.has(JSON.stringify([slowGroup.accountId, slowGroup.groupId]))).toBe(false);
  } finally {
    requestController.abort();
    timeout.mockRestore();
  }
});
