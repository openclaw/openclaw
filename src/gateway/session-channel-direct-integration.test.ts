import { beforeEach, expect, it, vi } from "vitest";
import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SessionSchema } from "../config/zod-schema.session-config.js";

const owner = vi.hoisted(() => ({ list: vi.fn(), authority: vi.fn(), role: vi.fn() }));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  listCanonicalUserChannelIdentities: owner.list,
  prepareUserChannelIdentityAuthority: owner.authority,
  prepareUserProfileRoleAuthority: owner.role,
}));
import { operatorSessionCap } from "./operator-role-policy.js";
import {
  prepareTelegramSessionReads,
  readTelegramSessionMembership,
  telegramSessionMembershipKey,
} from "./session-channel-read.js";
import { prepareSessionSharing } from "./session-sharing-read.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const profileId = "yana-profile";
const agentId = "tg123";
const peer = "123";
const base = `agent:${agentId}:telegram:direct:${peer}`;
const identity = { channelId: "telegram", accountId: "default", senderId: peer };
let linked = true;
function config(grant = true): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "none",
        definitions: {
          none: {
            agents: [agentId],
            scopes: ["operator.read", "operator.write"],
            sessions: { others: "none" },
          },
        },
      },
    },
    session: {
      sharing: {
        legacyDirectAccess: grant
          ? [
              {
                channel: "telegram",
                accountId: "default",
                agentId,
                peerId: peer,
                profileIds: [profileId],
              },
            ]
          : [],
      },
    },
  } as unknown as OpenClawConfig;
}
function entry(thread?: number, account = "default", sender = peer): SessionEntry {
  return {
    sessionId: "synthetic",
    updatedAt: 1,
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: sender },
    delivery: {
      kind: "external",
      context: {},
      route: {
        channel: "telegram",
        accountId: account,
        target: { to: `telegram:${sender}` },
        ...(thread === undefined ? {} : { thread: { id: thread } }),
      },
      origin: { provider: "telegram", chatType: "direct", accountId: account },
    },
  };
}
function target(key: string, row: SessionEntry) {
  return {
    agentId,
    canonicalKey: key,
    storeKey: key,
    storeKeys: [key],
    storePath: "/synthetic",
    entry: row,
  };
}
async function fixture(cfg = config(), user = profileId) {
  const controller = new AbortController();
  const client = sharingPolicyClient({ user });
  client.preparedSessionProfile = { profileId: user, aliases: new Set([user]), role: "none" };
  Object.assign(client, { connectionSignal: controller.signal, invalidated: false });
  await prepareTelegramSessionReads({ client, cfg, getConfig: () => cfg, groups: [] });
  expect(operatorSessionCap(client, cfg)).toBe("none");
  const sharing = prepareSessionSharing(
    { cfg, client },
    { aliases: new Set([user]), sessionCap: "none", isMember: () => false },
  );
  return { cfg, client, controller, sharing };
}
beforeEach(() => {
  vi.resetAllMocks();
  linked = true;
  owner.role.mockImplementation(async (profile: string) => ({
    profileId: profile,
    isCurrent: () => true,
  }));
  owner.list.mockImplementation(async (profile: string) =>
    profile === profileId ? [{ profileId, identity }] : [],
  );
  owner.authority.mockResolvedValue({ linked: { profileId }, isCurrent: () => linked });
});
it("accepts a legacy direct grant without activating source ACL for new sessions", () => {
  const cfg = config();
  expect(SessionSchema.safeParse(cfg.session).success).toBe(true);
  expect(cfg.session?.sharing?.accessPolicy).toBeUndefined();
  expect(resolveSessionCreationVisibility(cfg, "agent:main:telegram:group:-123")).toEqual({});
});
it.each([undefined, 42])(
  "allows linked DM through binding and sharing with others none (thread %s)",
  async (thread) => {
    const f = await fixture();
    const key = thread === undefined ? base : `${base}:thread:${peer}:${thread}`;
    const row = entry(thread);
    expect(readTelegramSessionMembership(f.client, f.cfg, key, row)).toBe(true);
    expect(f.sharing.canReadTarget(target(key, row))).toBe(true);
    expect(f.sharing.canReadDirectTarget(target(key, row))).toBe(true);
    f.controller.abort();
  },
);
it("denies a different profile and peer", async () => {
  const stranger = await fixture(config(), "stranger");
  expect(stranger.sharing.canReadTarget(target(base, entry()))).toBe(false);
  stranger.controller.abort();
  const f = await fixture();
  const key = `agent:${agentId}:telegram:direct:999`;
  expect(f.sharing.canReadDirectTarget(target(key, entry(undefined, "default", "999")))).toBe(
    false,
  );
  f.controller.abort();
});
it("revokes existing connection immediately on unlink", async () => {
  const f = await fixture();
  const row = entry();
  expect(f.sharing.canReadDirectTarget(target(base, row))).toBe(true);
  const before = telegramSessionMembershipKey(f.client, f.cfg);
  linked = false;
  expect(telegramSessionMembershipKey(f.client, f.cfg)).not.toBe(before);
  expect(f.sharing.canReadTarget(target(base, row))).toBe(false);
  expect(f.sharing.canReadDirectTarget(target(base, row))).toBe(false);
  f.controller.abort();
});
it("denies after grant removal and for another account", async () => {
  const revoked = await fixture(config(false));
  expect(revoked.sharing.canReadTarget(target(base, entry()))).toBe(false);
  revoked.controller.abort();
  const f = await fixture();
  expect(f.sharing.canReadDirectTarget(target(base, entry(undefined, "other")))).toBe(false);
  f.controller.abort();
});

it("does not bypass an explicit creator ACL", async () => {
  const f = await fixture();
  const row: SessionEntry = { ...entry(), access: { mode: "creator" } };
  expect(readTelegramSessionMembership(f.client, f.cfg, base, row)).toBe(true);
  expect(f.sharing.canReadTarget(target(base, row))).toBe(false);
  expect(f.sharing.canReadDirectTarget(target(base, row))).toBe(false);
  f.controller.abort();
});

it("does not bypass source ACL when the source policy excludes the profile", async () => {
  const cfg = config();
  cfg.session!.sharing!.accessPolicy = { default: "creator", groups: [] };
  const f = await fixture(cfg);
  const row: SessionEntry = { ...entry(), access: { mode: "source" } };
  expect(readTelegramSessionMembership(f.client, f.cfg, base, row)).toBe(true);
  expect(f.sharing.canReadTarget(target(base, row))).toBe(false);
  expect(f.sharing.canReadDirectTarget(target(base, row))).toBe(false);
  f.controller.abort();
});
