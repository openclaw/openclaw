import { expect, it } from "vitest";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import {
  gatewayConnect,
  gatewayProfile,
} from "../../gateway/server/client-fixtures.test-support.js";
import {
  authorizeSessionSharingTarget,
  prepareSessionSharingRole,
  type SessionSharingTarget,
} from "../../gateway/session-sharing-policy.js";
import {
  canReceiveSessionEvent,
  prepareSessionSharing,
} from "../../gateway/session-sharing-read.js";
import type { OpenClawConfig } from "../types.openclaw.js";

const cfg: OpenClawConfig = {
  session: {
    sharing: {
      accessPolicy: {
        default: "creator",
        groups: [
          { agentId: "main", channel: "telegram", peerId: "-100123", profileIds: ["selected"] },
        ],
      },
    },
  },
};
const target: SessionSharingTarget = {
  agentId: "main",
  canonicalKey: "agent:main:telegram:group:-100123",
  storeKey: "agent:main:telegram:group:-100123",
  storeKeys: [],
  storePath: "/synthetic/store",
  entry: {
    sessionId: "s",
    updatedAt: 1,
    visibility: "shared",
    access: { mode: "source" },
    createdActor: { type: "human", source: "profile", id: "creator" },
  },
};
const client = (id?: string, admin = false): GatewayClient => ({
  connect: gatewayConnect(admin ? ["operator.admin"] : ["operator.read", "operator.write"]),
  ...(id ? { authenticatedUserProfile: gatewayProfile(id) } : {}),
});
const sharing = (who: GatewayClient, config = cfg, cap: "write" | "none" = "write") =>
  prepareSessionSharing(
    { cfg: config, client: who },
    {
      aliases: new Set(
        who.authenticatedUserProfile ? [who.authenticatedUserProfile.profileId] : [],
      ),
      sessionCap: cap,
      isMember: () => true,
    },
  );

it("enforces confidential read/write/event admission against identical staff roles, regardless of members", () => {
  for (const [id, admin, expected] of [
    ["selected", false, true],
    ["outsider", false, false],
    ["creator", false, true],
    ["outsider", true, true],
  ] as const) {
    const who = client(id, admin);
    const policy = sharing(who);
    expect(policy.entryFilter?.(target.canonicalKey, target.entry) !== false).toBe(expected);
    expect(policy.authorizeTarget(target) === null).toBe(expected);
    for (const event of [
      "session.message",
      "sessions.changed",
      "session.typing",
      "session.suggestion",
    ]) {
      expect(
        canReceiveSessionEvent({
          cfg,
          client: who,
          sessionKeys: [target.canonicalKey],
          event,
          prepared: { sharing: policy, target: () => target },
        }),
      ).toBe(expected);
    }
  }
  const noIdentity = client();
  expect(sharing(noIdentity).entryFilter?.(target.canonicalKey, target.entry)).toBe(false);
  const role = prepareSessionSharingRole({ cfg, client: noIdentity }, { value: "write" })(
    target,
    true,
  );
  expect(
    authorizeSessionSharingTarget({ cfg, client: noIdentity, target }, { value: "write", role }),
  ).not.toBeNull();
  expect(
    canReceiveSessionEvent({
      cfg,
      client: noIdentity,
      sessionKeys: [target.canonicalKey],
      prepared: { sharing: sharing(noIdentity), target: () => target },
    }),
  ).toBe(false);
});

it("honors revocation before the next event/write and retains creator/admin and role ceilings", () => {
  const who = client("selected");
  expect(sharing(who).authorizeTarget(target)).toBeNull();
  const revoked: OpenClawConfig = {
    session: { sharing: { accessPolicy: { default: "creator", groups: [] } } },
  };
  expect(sharing(who, revoked).entryFilter?.(target.canonicalKey, target.entry)).toBe(false);
  expect(sharing(who, revoked).authorizeTarget(target)).not.toBeNull();
  expect(
    canReceiveSessionEvent({
      cfg: revoked,
      client: who,
      sessionKeys: [target.canonicalKey],
      prepared: { sharing: sharing(who, revoked), target: () => target },
    }),
  ).toBe(false);
  expect(sharing(who, cfg, "none").authorizeTarget(target)).not.toBeNull();
  expect(sharing(client("creator"), revoked, "none").authorizeTarget(target)).toBeNull();
  expect(sharing(client("outsider", true), revoked, "none").authorizeTarget(target)).toBeNull();
});

it("does not redefine Draft or let audience members manage access", () => {
  const selected = client("selected");
  const policy = sharing(selected);
  expect(
    authorizeSessionSharingTarget(
      { cfg, client: selected, target, requireOwner: true },
      { value: "write", role: policy.roleForTarget(target) },
    ),
  ).not.toBeNull();
  const draft = { ...target, entry: { ...target.entry, visibility: "draft" as const } };
  expect(policy.entryFilter?.(target.canonicalKey, draft.entry)).toBe(false);
  expect(policy.authorizeTarget(draft)).not.toBeNull();
});
