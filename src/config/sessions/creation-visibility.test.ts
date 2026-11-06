import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import { SessionSchema } from "../zod-schema.session-config.js";
import { resolveSessionCreationVisibility } from "./creation-visibility.js";
import { canReadSessionAccess } from "./session-access.js";
import { applySessionEntryWritePolicy } from "./session-entry-write-policy.js";

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

describe("source-bound creation without visual defaults", () => {
  it.each([
    "agent:main:telegram:direct:123:thread:42",
    "agent:main:telegram:work-bot:direct:123:thread:42",
    "agent:personal:telegram:direct:123",
    "agent:main:dashboard:new-web-chat",
    "agent:main:subagent:private-child",
    "agent:main:telegram:group:-100999",
    "agent:main:telegram:channel:-100123",
    "agent:personal:telegram:group:-100123",
    "agent:main:discord:group:-100123",
    "agent:main:telegram:group:-100123:topic:x",
    "agent:main:agent:main:telegram:group:-100123",
    "unknown",
  ])("binds %s before disclosure, including unknown or unapproved sources", (sessionKey) => {
    const entry = resolveSessionCreationVisibility(cfg, sessionKey);
    expect(entry).toEqual({ access: { mode: "source" } });
    expect(canReadSessionAccess(cfg, sessionKey, entry, () => false)).toBe(false);
  });

  it("resolves exact source audiences without changing visibility", () => {
    for (const key of [
      "agent:main:telegram:group:-100123",
      "agent:main:telegram:group:-100123:thread:7",
      "agent:main:telegram:group:-100123:topic:7",
    ]) {
      const entry = resolveSessionCreationVisibility(cfg, key);
      expect(entry).toEqual({ access: { mode: "source" } });
      expect(canReadSessionAccess(cfg, key, entry, (actor) => actor?.id === "selected")).toBe(true);
    }
    expect(resolveSessionCreationVisibility({}, "agent:main:dashboard:legacy")).toEqual({});
  });

  it("keeps Draft independent and rejects deferred creation defaults", () => {
    expect(SessionSchema.safeParse(cfg.session).success).toBe(true);
    expect(
      SessionSchema.safeParse({ sharing: { ...cfg.session?.sharing, drafts: false } }).success,
    ).toBe(true);
    expect(
      SessionSchema.safeParse({ sharing: { creationDefaults: { visibility: "draft" } } }).success,
    ).toBe(false);
  });
});

it("does not disclose Draft conversations when their transcript identity is replaced", () => {
  const previous = { sessionId: "before", updatedAt: 1, visibility: "draft" as const };
  const replacement = { sessionId: "after", updatedAt: 2 };
  expect(
    applySessionEntryWritePolicy(
      "main",
      "agent:main:private",
      replacement,
      replacement,
      previous,
      {},
    ).entry.visibility,
  ).toBe("draft");
});

it.each([
  undefined,
  { mode: "unrestricted" as const },
  { mode: "creator" as const },
  { mode: "audience" as const, profileIds: ["selected"] },
  { mode: "source" as const },
])("keeps child confidentiality opt-in without copying a parent's audience: %j", (access) => {
  const policy = resolveSessionCreationVisibility({}, "agent:main:subagent:child", { access });
  const privateChild = access !== undefined && access.mode !== "unrestricted";
  expect(policy.access).toEqual(privateChild ? { mode: "creator" } : undefined);
  expect(canReadSessionAccess({}, "agent:main:subagent:child", policy, () => false)).toBe(
    !privateChild,
  );
  expect(
    resolveSessionCreationVisibility(
      { session: { sharing: { accessPolicy: { default: "creator" } } } },
      "agent:main:subagent:child",
      { access },
    ).access,
  ).toEqual({ mode: "source" });
});

it("keeps a Draft parent's copied context confidential without a global access policy", () => {
  const child = resolveSessionCreationVisibility({}, "agent:main:dashboard:fork", {
    visibility: "draft",
  });
  expect(child.access).toEqual({ mode: "creator" });
  expect(canReadSessionAccess({}, "agent:main:dashboard:fork", child, () => false)).toBe(false);
});
