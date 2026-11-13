import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, expect, it } from "vitest";
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
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";

const profiles = new Map<string, string>();
const profile = (name: string) => expectDefined(profiles.get(name), "admitted profile");
const audience: string[] = [];
const createdActor = { type: "human" as const, source: "profile" as const, id: "" };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true });
  for (const name of ["selected", "outsider", "creator"]) {
    profiles.set(name, (await ensureCanonicalUserProfileForEmail(`${name}@admission.test`)).id);
  }
  audience.push(profile("selected"));
  createdActor.id = profile("creator");
});
afterAll(async () => state.cleanup());
const accessPolicy = {
  default: "creator" as const,
  groups: [{ agentId: "main", channel: "telegram", peerId: "-100123", profileIds: audience }],
};
const cfg: OpenClawConfig = { session: { sharing: { accessPolicy } } };
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
    createdActor,
  },
};
const client = (id?: string, admin = false): GatewayClient => ({
  connect: gatewayConnect(admin ? ["operator.admin"] : ["operator.read", "operator.write"]),
  ...(id ? { authenticatedUserProfile: gatewayProfile(profile(id)) } : {}),
});
const sharing = (who: GatewayClient, config = cfg, cap: "write" | "none" = "write") =>
  prepareSessionSharing(
    { cfg: config, client: who },
    {
      aliases: new Set([who.authenticatedUserProfile?.profileId].filter((id) => id !== undefined)),
      sessionCap: cap,
      isMember: () => true,
    },
  );
const receives = (who: GatewayClient, config = cfg, view = sharing(who, config), event?: string) =>
  canReceiveSessionEvent({
    cfg: config,
    client: who,
    sessionKeys: [target.canonicalKey],
    ...(event === undefined ? {} : { event }),
    prepared: { sharing: view, target: () => target },
  });

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
    const events = ["session.message", "sessions.changed", "session.typing", "session.suggestion"];
    for (const event of events) {
      expect(receives(who, cfg, policy, event)).toBe(expected);
    }
  }
  const noIdentity = client();
  expect(sharing(noIdentity).entryFilter?.(target.canonicalKey, target.entry)).toBe(false);
  const caller = { cfg, client: noIdentity, target };
  const role = prepareSessionSharingRole(caller, { value: "write" })(target, true);
  expect(authorizeSessionSharingTarget(caller, { value: "write", role })).not.toBeNull();
  expect(receives(noIdentity)).toBe(false);
});

it("honors revocation before the next event/write and retains creator/admin and role ceilings", () => {
  const who = client("selected");
  expect(sharing(who).authorizeTarget(target)).toBeNull();
  const revokedPolicy = { ...accessPolicy, groups: [] };
  const revoked: OpenClawConfig = { session: { sharing: { accessPolicy: revokedPolicy } } };
  expect(sharing(who, revoked).entryFilter?.(target.canonicalKey, target.entry)).toBe(false);
  expect(sharing(who, revoked).authorizeTarget(target)).not.toBeNull();
  expect(receives(who, revoked)).toBe(false);
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

it("keeps legacy role and visibility read/write/event decisions when source policy is enabled", () => {
  for (const identified of [false, true]) {
    const who = identified ? client("outsider") : client();
    const policy = sharing(who);
    const legacy = { ...target, entry: { ...target.entry, access: undefined } };
    expect(policy.entryFilter?.(legacy.canonicalKey, legacy.entry) !== false).toBe(true);
    expect(policy.authorizeTarget(legacy)).toBeNull();
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
          sessionKeys: [legacy.canonicalKey],
          event,
          prepared: { sharing: policy, target: () => legacy },
        }),
      ).toBe(identified || (event !== "session.typing" && event !== "session.suggestion"));
    }
    const draft = { ...legacy, entry: { ...legacy.entry, visibility: "draft" as const } };
    expect(policy.entryFilter?.(draft.canonicalKey, draft.entry)).toBe(!identified);
    expect(policy.authorizeTarget(draft) === null).toBe(!identified);
    expect(sharing(who, cfg, "none").authorizeTarget(legacy) === null).toBe(!identified);
    expect(policy.authorizeTarget(target)).not.toBeNull();
  }
});
