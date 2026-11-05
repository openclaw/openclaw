import { expect, it } from "vitest";
import { resolveSessionCreationVisibility } from "../config/sessions/creation-visibility.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionCreateVisibility } from "./session-create-visibility.js";
import {
  prepareSessionSharingRole,
  authorizeSessionSharingTarget,
} from "./session-sharing-policy.js";
import { createProfileSessionEntryFilter } from "./session-sharing-read.js";
import { sharingPolicyClient, sharingPolicyTarget } from "./session-sharing.test-utils.js";

const cfg: OpenClawConfig = {
  session: {
    sharing: {
      creationDefaults: {
        visibility: "draft",
        sharedGroups: [{ agentId: "main", channel: "telegram", peerId: "-100123" }],
      },
    },
  },
};

it("preserves explicit creation choices and existing shared/draft sessions", () => {
  const sessionKey = "agent:main:dashboard:new";
  const params = { cfg, sessionKey, defaultVisibility: "shared" as const };
  expect(resolveSessionCreateVisibility(params, undefined)).toEqual({ ok: true, value: "draft" });
  expect(resolveSessionCreateVisibility({ ...params, visibility: "shared" }, undefined)).toEqual({
    ok: true,
    value: "shared",
  });
  for (const visibility of ["draft", "shared", "read-only", "suggest"] as const) {
    const existing = { sessionId: "existing", updatedAt: 1, visibility };
    expect(resolveSessionCreateVisibility(params, existing)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(resolveSessionCreateVisibility({ ...params, visibility }, existing).ok).toBe(true);
  }
});

it("uses existing creator-only Draft discovery even with a write ceiling", () => {
  const filter = (profileId: string) =>
    createProfileSessionEntryFilter(
      { profileId, sessionCap: "write" },
      (actor) => actor?.id === profileId,
    );
  const entry = {
    ...resolveSessionCreationVisibility(cfg, "agent:main:dashboard:new"),
    createdActor: { type: "human" as const, source: "profile" as const, id: "creator" },
  };
  expect(filter("staff")("key", entry)).toBe(false);
  expect(filter("creator")("key", entry)).toBe(true);
  expect(
    filter("staff")("key", {
      ...entry,
      visibility: "shared",
    }),
  ).toBe(true);
  expect(
    filter("creator")("key", {
      ...entry,
      incognito: true,
    }),
  ).toBe(false);
});

it("does not confuse participation membership with selected-person confidentiality", () => {
  const client = sharingPolicyClient({ user: "staff-outsider" });
  const isCreator = () => false;
  const visible = createProfileSessionEntryFilter(
    { profileId: "staff-outsider", sessionCap: "write" },
    isCreator,
  );
  const roleFor = prepareSessionSharingRole({ cfg: {}, client }, { value: "write" }, isCreator);
  for (const visibility of ["shared", "read-only", "suggest", "draft"] as const) {
    const target = sharingPolicyTarget({ type: "human", id: "creator" });
    target.entry.visibility = visibility;
    // Membership is not a read-confidentiality filter, and write-cap staff do
    // not need membership to participate in any non-Draft conversation.
    for (const member of [false, true]) {
      expect(visible(target.canonicalKey, target.entry)).toBe(visibility !== "draft");
      const role = roleFor(target, member);
      const denied = authorizeSessionSharingTarget(
        { cfg: {}, client, target, isMember: member },
        { value: "write", role },
      );
      expect(denied === null).toBe(visibility !== "draft");
    }
  }
});
