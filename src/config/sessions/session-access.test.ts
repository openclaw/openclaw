import { describe, expect, it } from "vitest";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { SessionSchema } from "../zod-schema.session-config.js";
import { resolveSessionCreationVisibility } from "./creation-visibility.js";
import { canReadSessionAccess, resolveSessionAccess } from "./session-access.js";
import { applySessionEntryWritePolicy } from "./session-entry-write-policy.js";
import { resolveSessionPublicShare } from "./session-public-share.js";
import type { SessionEntry } from "./types.js";

function configWithGroups(
  groups: NonNullable<
    NonNullable<NonNullable<OpenClawConfig["session"]>["sharing"]>["accessPolicy"]
  >["groups"],
): OpenClawConfig {
  return { session: { sharing: { accessPolicy: { default: "creator", groups } } } };
}
const selectedGroup = {
  agentId: "main",
  channel: "telegram",
  peerId: "-100123",
  profileIds: ["selected"],
};
const cfg = configWithGroups([{ ...selectedGroup, peerAliases: ["-456"] }]);
const group = "agent:main:telegram:group:-100123";
const entry: SessionEntry = {
  sessionId: "s",
  updatedAt: 1,
  createdActor: { type: "human", source: "profile", id: "creator" },
  access: { mode: "source" },
};
const matches = (id: string) => (actor: SessionEntry["createdActor"]) =>
  actor?.type === "human" && actor.source === "profile" && actor.id === id;

const readAccess = (config: OpenClawConfig, key: string, id: string, stored = entry) =>
  canReadSessionAccess(config, key, stored, matches(id));

describe("confidential session access, independent of visibility and participation", () => {
  it("admits only selected people and creator, resolving topic/thread and explicit migration aliases", () => {
    for (const key of [
      group,
      group + ":topic:7",
      group + ":thread:8",
      group + ":topic:7:thread:8",
      "agent:main:telegram:group:-456",
    ]) {
      expect(readAccess(cfg, key, "selected")).toBe(true);
      expect(readAccess(cfg, key, "outsider")).toBe(false);
      expect(readAccess(cfg, key, "creator")).toBe(true);
    }
  });
  it("fails closed for DMs, children, web, unknown agent/account/group and ambiguous suffixes", () => {
    for (const key of [
      "agent:main:telegram:direct:123",
      "agent:main:telegram:bot:direct:123:thread:3",
      "agent:main:dashboard:web",
      "agent:main:subagent:child",
      "agent:personal:telegram:group:-100123",
      "agent:main:telegram:bot:group:-100123",
      group + "4",
      group + ":topic:x",
      group + ":thread:unknown",
      group + ":child:7",
      "unknown",
    ]) {
      expect(readAccess(cfg, key, "selected")).toBe(false);
    }
  });
  it("closes ambiguous duplicate routes rather than borrowing the first grant", () => {
    const duplicate = configWithGroups([
      selectedGroup,
      { ...selectedGroup, profileIds: ["other"] },
    ]);
    expect(readAccess(duplicate, group, "selected")).toBe(false);
  });
  it("supports account-specific group routes without granting other accounts", () => {
    const accountCfg = configWithGroups([{ ...selectedGroup, accountId: "bot" }]);
    expect(
      readAccess(accountCfg, "agent:main:telegram:bot:group:-100123:topic:9", "selected"),
    ).toBe(true);
    expect(readAccess(accountCfg, group, "selected")).toBe(false);
  });
  it("matches canonical default-account inbound groups without making omitted account a wildcard", () => {
    const inboundKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "telegram",
      accountId: "default",
      peerKind: "group",
      peerId: "-100123",
    });
    expect(inboundKey).toBe(group);
    const initial = resolveSessionCreationVisibility(cfg, inboundKey);
    expect(initial.access).toEqual({ mode: "source" });
    for (const key of [inboundKey, inboundKey + ":topic:7", inboundKey + ":thread:8"]) {
      expect(canReadSessionAccess(cfg, key, { ...entry, ...initial }, matches("selected"))).toBe(
        true,
      );
    }
    for (const accountId of ["default", "other-bot"]) {
      expect(
        readAccess(cfg, `agent:main:telegram:${accountId}:group:-100123:topic:7`, "selected"),
      ).toBe(false);
    }
  });
  it("revokes explicit source bindings but preserves legacy unset access after policy activation", () => {
    const revoked: OpenClawConfig = {
      session: { sharing: { accessPolicy: { default: "creator", groups: [] } } },
    };
    expect(readAccess(cfg, group, "selected")).toBe(true);
    expect(readAccess(revoked, group, "selected")).toBe(false);
    expect(readAccess({}, group, "selected")).toBe(false);
    expect(
      canReadSessionAccess(revoked, group, { ...entry, access: undefined }, matches("selected")),
    ).toBe(true);
  });
  it("preserves explicit overrides and matches canonical profile aliases", () => {
    const audience: SessionEntry = {
      ...entry,
      access: { mode: "audience", profileIds: ["old-profile"] },
    };
    expect(
      canReadSessionAccess(
        cfg,
        group,
        audience,
        (actor) => actor?.id === "old-profile" || actor?.id === "selected",
      ),
    ).toBe(true);
    expect(resolveSessionAccess(cfg, group, { access: { mode: "creator" } })).toEqual({
      mode: "creator",
    });
    expect(resolveSessionAccess(cfg, group, { access: { mode: "unrestricted" } })).toEqual({
      mode: "unrestricted",
    });
  });
  it("stamps source access before creation independently of Draft", () => {
    expect(resolveSessionCreationVisibility(cfg, "agent:main:dashboard:new")).toEqual({
      access: { mode: "source" },
    });
    expect(SessionSchema.safeParse(cfg.session).success).toBe(true);
    expect(
      SessionSchema.safeParse({ sharing: { drafts: false, accessPolicy: { default: "creator" } } })
        .success,
    ).toBe(true);
  });
  it("revokes an old public bearer grant as soon as access becomes confidential", () => {
    const publicEntry = {
      ...entry,
      publicShare: { id: "a".repeat(48), sessionId: entry.sessionId, createdAt: 1 },
    };
    expect(
      resolveSessionPublicShare({ ...publicEntry, access: { mode: "unrestricted" } }),
    ).toBeDefined();
    for (const access of [
      { mode: "creator" },
      { mode: "source" },
      { mode: "audience", profileIds: ["selected"] },
    ] satisfies NonNullable<SessionEntry["access"]>[]) {
      expect(resolveSessionPublicShare({ ...publicEntry, access })).toBeUndefined();
    }
  });
  it("retains a revoked audience against stale bookkeeping and transcript replacement", () => {
    const current: SessionEntry = { ...entry, access: { mode: "creator" } };
    const stale: SessionEntry = {
      ...entry,
      sessionId: "replacement",
      access: { mode: "audience", profileIds: ["revoked"] },
    };
    expect(
      applySessionEntryWritePolicy("main", group, stale, stale, current, {}).entry.access,
    ).toEqual({ mode: "creator" });
    expect(
      applySessionEntryWritePolicy("main", group, current, stale, current, {
        allowStoredAliases: true,
      }).entry.access,
    ).toEqual(stale.access);
  });
});
