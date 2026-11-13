import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveTelegramSessionGroup } from "./session-channel-group.js";

const mocks = vi.hoisted(() => ({
  prepareRoleAuthority: vi.fn(),
  prepareMemberships: vi.fn(),
}));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: mocks.prepareRoleAuthority,
}));
vi.mock("./session-channel-membership.js", () => ({
  prepareTelegramGroupMemberships: mocks.prepareMemberships,
}));

import {
  prepareTelegramSessionReads,
  readTelegramSessionMembership,
  telegramSessionMembershipKey,
} from "./session-channel-read.js";

type Group = { accountId: string; groupId: string };
type MembershipFact = { isCurrent: () => boolean };
type MembershipFacts = Map<string, MembershipFact | undefined>;

const membershipKey = (group: Group) => JSON.stringify([group.accountId, group.groupId]);
const config = () => ({}) as OpenClawConfig;

function makeFact(isCurrent: () => boolean = () => true): MembershipFact {
  return { isCurrent };
}

function factsFor(groups: readonly Group[], fact = makeFact()): MembershipFacts {
  return new Map(groups.map((group) => [membershipKey(group), fact]));
}

function makeConnection(profileId = "profile", internal: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const client = {
    authenticatedUserProfile: { profileId },
    connectionSignal: controller.signal,
    internal,
    invalidated: false,
  } as unknown as GatewayClient;
  return { client, controller };
}

function setProfile(client: GatewayClient, profileId: string) {
  (
    client as unknown as { authenticatedUserProfile: { profileId: string } }
  ).authenticatedUserProfile.profileId = profileId;
}

function sessionEntry(group: Group, topic?: string): SessionEntry {
  const target = topic ? `${group.groupId}:topic:${topic}` : group.groupId;
  return {
    sessionId: "synthetic-channel-session",
    updatedAt: 1,
    createdVia: "channel",
    delivery: {
      kind: "external",
      route: {
        channel: "telegram",
        accountId: group.accountId,
        target: { to: `telegram:${target}` },
        ...(topic ? { thread: { id: topic } } : {}),
      },
      context: {},
      origin: { provider: "telegram", chatType: "group", nativeChannelId: target },
    },
  };
}

function sessionKey(group: Group, topic?: string) {
  return `agent:main:telegram:group:${group.groupId}${topic ? `:topic:${topic}` : ""}`;
}

function isMember(client: GatewayClient, cfg: OpenClawConfig, group: Group, topic?: string) {
  return readTelegramSessionMembership(
    client,
    cfg,
    sessionKey(group, topic),
    sessionEntry(group, topic),
  );
}

function prepareReads(params: {
  client: GatewayClient;
  cfg: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  getConfig: () => OpenClawConfig;
  groups: readonly Group[];
}) {
  return prepareTelegramSessionReads(params);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.prepareRoleAuthority.mockImplementation(async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }));
  mocks.prepareMemberships.mockImplementation(async (params: { groups: readonly Group[] }) =>
    factsFor(params.groups),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps positive facts on the connection and refreshes outside the request context", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const runtimeConfig = config();
  const group = { accountId: "default", groupId: "-123" };
  const context = new AsyncLocalStorage<string>();
  const observedContexts: Array<string | undefined> = [];
  mocks.prepareMemberships.mockImplementation(async (params: { groups: readonly Group[] }) => {
    observedContexts.push(context.getStore());
    return factsFor(params.groups);
  });

  await context.run("originating-rpc", () =>
    prepareReads({ client, cfg, runtimeConfig, getConfig: () => cfg, groups: [group] }),
  );

  expect(observedContexts).toEqual(["originating-rpc"]);
  expect(isMember(client, cfg, group)).toBe(true);
  expect(isMember(client, runtimeConfig, group)).toBe(true);
  expect(telegramSessionMembershipKey(client, cfg)).not.toBe("");
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(30_000);

  expect(observedContexts).toEqual(["originating-rpc", undefined]);
  expect(mocks.prepareMemberships).toHaveBeenCalledTimes(2);
  expect(isMember(client, cfg, group)).toBe(true);
  controller.abort();
  expect(vi.getTimerCount()).toBe(0);
});

it("revokes cached visibility when the connection-owned refresh returns negative", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const group = { accountId: "default", groupId: "-123" };
  mocks.prepareMemberships
    .mockResolvedValueOnce(factsFor([group]))
    .mockResolvedValueOnce(new Map([[membershipKey(group), undefined]]));
  await prepareReads({ client, cfg, getConfig: () => cfg, groups: [group] });
  const before = telegramSessionMembershipKey(client, cfg);
  expect(isMember(client, cfg, group)).toBe(true);

  await vi.advanceTimersByTimeAsync(30_000);

  expect(mocks.prepareMemberships).toHaveBeenCalledTimes(2);
  expect(isMember(client, cfg, group)).toBe(false);
  expect(telegramSessionMembershipKey(client, cfg)).not.toBe(before);
  expect(vi.getTimerCount()).toBe(0);
  controller.abort();
});

it("revokes immediately when the membership witness reports leave or unlink", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const group = { accountId: "default", groupId: "-123" };
  let linkedAndMember = true;
  mocks.prepareMemberships.mockResolvedValueOnce(
    factsFor(
      [group],
      makeFact(() => linkedAndMember),
    ),
  );
  await prepareReads({ client, cfg, getConfig: () => cfg, groups: [group] });
  const before = telegramSessionMembershipKey(client, cfg);
  expect(isMember(client, cfg, group)).toBe(true);

  linkedAndMember = false;

  expect(isMember(client, cfg, group)).toBe(false);
  expect(telegramSessionMembershipKey(client, cfg)).not.toBe(before);
  expect(mocks.prepareMemberships).toHaveBeenCalledTimes(1);
  controller.abort();
});

it("disconnect clears the refresh timer and the connection-owned cache", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const group = { accountId: "default", groupId: "-123" };
  await prepareReads({ client, cfg, getConfig: () => cfg, groups: [group] });
  expect(isMember(client, cfg, group)).toBe(true);
  expect(vi.getTimerCount()).toBe(1);

  controller.abort();

  expect(isMember(client, cfg, group)).toBe(false);
  expect(telegramSessionMembershipKey(client, cfg)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(mocks.prepareMemberships).toHaveBeenCalledTimes(1);
});

it("does not publish a late positive result after the connection aborts", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const group = { accountId: "default", groupId: "-123" };
  let finish!: (facts: MembershipFacts) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mocks.prepareMemberships.mockImplementationOnce(() => {
    started();
    return new Promise<MembershipFacts>((resolve) => {
      finish = resolve;
    });
  });

  const pending = prepareReads({ client, cfg, getConfig: () => cfg, groups: [group] });
  await requestStarted;
  controller.abort();
  finish(factsFor([group]));
  await pending;

  expect(isMember(client, cfg, group)).toBe(false);
  expect(telegramSessionMembershipKey(client, cfg)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["profile", "account", "config"] as const)(
  "does not reuse cached facts across a changed %s scope",
  async (scope) => {
    const { client, controller } = makeConnection("profile-a");
    const cfgA = config();
    const cfgB = config();
    let activeConfig = cfgA;
    const initialGroup = { accountId: "default", groupId: "-123" };
    await prepareReads({
      client,
      cfg: cfgA,
      getConfig: () => activeConfig,
      groups: [initialGroup],
    });
    expect(isMember(client, cfgA, initialGroup)).toBe(true);

    let nextConfig = cfgA;
    let nextGroup = initialGroup;
    if (scope === "profile") {
      setProfile(client, "profile-b");
    } else if (scope === "account") {
      nextGroup = { accountId: "secondary", groupId: "-123" };
    } else {
      activeConfig = cfgB;
      nextConfig = cfgB;
    }

    await prepareReads({
      client,
      cfg: nextConfig,
      getConfig: () => activeConfig,
      groups: [nextGroup],
    });

    expect(mocks.prepareMemberships).toHaveBeenCalledTimes(2);
    expect(mocks.prepareMemberships.mock.calls[1]?.[0].groups).toEqual([nextGroup]);
    expect(isMember(client, nextConfig, nextGroup)).toBe(true);
    controller.abort();
  },
);

it("invalidates old facts when the trusted runtime-config pointer changes", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const runtimeA = config();
  const runtimeB = config();
  const group = { accountId: "default", groupId: "-123" };
  await prepareReads({
    client,
    cfg,
    runtimeConfig: runtimeA,
    getConfig: () => cfg,
    groups: [group],
  });
  expect(isMember(client, runtimeA, group)).toBe(true);

  let finish!: (facts: MembershipFacts) => void;
  mocks.prepareMemberships.mockImplementationOnce(
    () =>
      new Promise<MembershipFacts>((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = prepareReads({
    client,
    cfg,
    runtimeConfig: runtimeB,
    getConfig: () => cfg,
    groups: [group],
  });

  expect(mocks.prepareMemberships).toHaveBeenCalledTimes(2);
  expect(mocks.prepareMemberships.mock.calls[1]?.[0].cfg).toBe(runtimeB);
  expect(isMember(client, runtimeB, group)).toBe(false);
  finish(factsFor([group]));
  await refresh;
  expect(isMember(client, runtimeB, group)).toBe(true);
  controller.abort();
});

it("batches duplicate topic sessions as one canonical Telegram group", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const groups = Array.from({ length: 24 }, (_, index) => {
    const topic = String(index + 1);
    const session = resolveTelegramSessionGroup(
      `agent:main:telegram:group:-123:topic:${topic}`,
      sessionEntry({ accountId: "default", groupId: "-123" }, topic),
    );
    if (!session) {
      throw new Error(`expected Telegram topic ${topic} to resolve to its group`);
    }
    return session;
  });

  await prepareReads({ client, cfg, getConfig: () => cfg, groups });

  expect(mocks.prepareMemberships).toHaveBeenCalledTimes(1);
  expect(mocks.prepareMemberships.mock.calls[0]?.[0].groups).toEqual([
    { accountId: "default", groupId: "-123" },
  ]);
  controller.abort();
});

it.each(["agentToolCaller", "agentRuntimeIdentity"] as const)(
  "does not cache or refresh membership for native %s clients",
  async (identity) => {
    const { client, controller } = makeConnection("profile", { [identity]: true });
    const cfg = config();
    const group = { accountId: "default", groupId: "-123" };

    await prepareReads({ client, cfg, getConfig: () => cfg, groups: [group] });

    expect(mocks.prepareRoleAuthority).not.toHaveBeenCalled();
    expect(mocks.prepareMemberships).not.toHaveBeenCalled();
    expect(isMember(client, cfg, group)).toBe(false);
    expect(telegramSessionMembershipKey(client, cfg)).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
  },
);

it("joins simultaneous preparations on one connection without leaking duplicate refresh owners", async () => {
  const { client, controller } = makeConnection();
  const cfg = config();
  const group = { accountId: "default", groupId: "-123" };
  let admit!: (authority: { profileId: string; isCurrent: () => boolean }) => void;
  const role = new Promise<{ profileId: string; isCurrent: () => boolean }>((resolve) => {
    admit = resolve;
  });
  mocks.prepareRoleAuthority.mockReturnValue(role);
  const params = { client, cfg, getConfig: () => cfg, groups: [group] };
  const first = prepareReads(params);
  const second = prepareReads(params);
  admit({ profileId: "profile", isCurrent: () => true });
  await Promise.all([first, second]);
  expect(isMember(client, cfg, group)).toBe(true);
  expect(mocks.prepareMemberships).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  expect(vi.getTimerCount()).toBe(0);
});
