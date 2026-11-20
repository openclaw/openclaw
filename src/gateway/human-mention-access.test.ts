import { expect, it } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { createHumanMentionPolicy } from "./human-mention-policy.js";
import { SESSION_KEY, mentionRoles, withMentionInbox } from "./mention-inbox.test-support.js";

it("validates per-recipient mention grants while preserving legacy recipient eligibility", () => {
  const cfg = mentionRoles({
    guest: {
      agents: "*",
      scopes: ["operator.sessions.read"],
      sessions: { others: "invited", maxInvitedAccess: "suggest" },
    },
  });
  return withMentionInbox(async (f) => {
    setUserProfileRole(f.bob.id, "guest");
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    const target = { ...scope, entry: loadSessionEntry(scope)! };
    const prepare = (
      access?: "read" | "suggest" | "send",
      client = f.aliceClient,
      profileId = f.bob.id,
    ) =>
      f.inbox.prepareInvitation(client, target, [
        { profileId, token: "@Bob", ...(access ? { access } : {}) },
      ]);
    expect(prepare()?.invitation.profiles).toMatchObject([{ profileId: f.bob.id, access: "read" }]);
    expect(prepare("suggest")?.invitation.profiles).toMatchObject([{ access: "suggest" }]);
    expect(() => prepare("send")).toThrow("exceeds");
    expect(() => prepare("read", f.aliceClient, f.carol.id)).toThrow("only supported");
    expect(() => prepare("read", f.carolClient)).toThrow("creator or an admin");
    expect(prepare(undefined, f.carolClient)).toBeUndefined();
    expect(() =>
      f.inbox.prepareInvitation(f.aliceClient, target, [
        { profileId: f.bob.id, token: "@Bob", access: "read" },
        { profileId: f.bob.id, token: "@Bob", access: "suggest" },
      ]),
    ).toThrow("Conflicting");
    const policy = createHumanMentionPolicy({
      getRuntimeConfig: () => cfg,
      getClients: () => f.clients,
      readSessionTarget: () => null,
    });
    try {
      const recipientTarget = { ...target, membership: new Set<string>() };
      expect(policy.recipientProfile(f.bob.id, recipientTarget, cfg)).toBeUndefined();
      expect(policy.recipientProfile(f.bob.id, recipientTarget, cfg, true)?.profileId).toBe(
        f.bob.id,
      );
      for (const access of ["read", "suggest", "send"] as const) {
        expect(
          policy.recipientProfile(
            f.bob.id,
            {
              ...recipientTarget,
              membership: new Set([f.bob.id]),
              memberAccess: { [f.bob.id]: access },
            },
            cfg,
          )?.profileId,
        ).toBe(f.bob.id);
      }
      for (const others of ["none", "invited", "view", "suggest", "write"] as const) {
        cfg.gateway!.roles!.definitions.guest!.sessions = { others };
        for (const visibility of ["shared", "read-only", "suggest", "draft"] as const) {
          for (const present of [false, true]) {
            expect(
              Boolean(
                policy.recipientProfile(
                  f.bob.id,
                  {
                    ...recipientTarget,
                    entry: { ...target.entry, visibility },
                    membership: new Set(present ? [f.bob.id] : []),
                  },
                  cfg,
                ),
              ),
            ).toBe(
              visibility !== "draft" && others !== "none" && (others !== "invited" || present),
            );
          }
        }
      }
    } finally {
      policy.dispose();
    }
  }, cfg);
});
