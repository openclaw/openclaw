import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "../../config/sessions/session-accessor.sqlite-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  hasSessionControlAuthority,
  prepareSessionControlTarget,
  readSessionControlAuthority,
} from "./sessions-control-authority.js";

function issueAuthority(profileId: string, scopes: readonly string[] = ["operator.write"]) {
  const controller = new AbortController();
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes,
    signal: controller.signal,
    assertCurrent: () => {},
  });
  return {
    authority,
    revoke: () => controller.abort(new Error("session control source revoked")),
  };
}

describe("session control source capability", () => {
  it.each([
    { scopes: [], allowed: false },
    { scopes: ["operator.read"], allowed: false },
    { scopes: ["operator.sessions.write"], allowed: false },
    { scopes: ["operator.read", "operator.sessions.write"], allowed: false },
    { scopes: ["operator.write"], allowed: true },
    { scopes: ["operator.admin"], allowed: true },
  ])("requires broad write authority for $scopes", ({ scopes, allowed }) => {
    const { authority } = issueAuthority("control-profile", scopes);
    expect(readSessionControlAuthority(authority)).toBe(authority);
    expect(hasSessionControlAuthority(authority)).toBe(allowed);
  });

  it("never mints authority from absence, matching fields, a copy, or a revoked source", () => {
    expect(readSessionControlAuthority()).toBeUndefined();
    expect(hasSessionControlAuthority()).toBe(false);
    const { authority, revoke } = issueAuthority("control-profile");
    const forged: AdmittedRunOperatorAuthority = {
      profileId: authority.profileId,
      scopes: authority.scopes,
      assertCurrent: () => {},
    };
    for (const unissued of [forged, { ...authority }]) {
      expect(() => readSessionControlAuthority(unissued)).toThrow(/issued by the host/i);
      expect(() => hasSessionControlAuthority(unissued)).toThrow(/issued by the host/i);
    }
    revoke();
    expect(() => readSessionControlAuthority(authority)).toThrow("session control source revoked");
    expect(() => hasSessionControlAuthority(authority)).toThrow("session control source revoked");
  });

  it("resolves the ambient original but rejects an unrelated prepared upgrade", async () => {
    const { authority } = issueAuthority("control-profile", ["operator.read"]);
    const { authority: upgrade } = issueAuthority("control-profile", ["operator.admin"]);
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:dashboard:caller", operatorAuthority: authority },
      () => {
        expect(readSessionControlAuthority()).toBe(authority);
        expect(hasSessionControlAuthority()).toBe(false);
        expect(() => hasSessionControlAuthority(upgrade)).toThrow(/source changed/i);
      },
    );
  });
});

describe("prepared session control target", () => {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  let state: OpenClawTestState | undefined;
  let callerId: string;
  let aliasId: string;
  let otherId: string;

  beforeAll(async () => {
    // Share only physical stores; cases use separate rows and release every prepared capture.
    state = await createOpenClawTestState({ scenario: "minimal", label: "session-control" });
    callerId = ensureProfileForEmail("session-controller@example.test").id;
    aliasId = ensureProfileForEmail("former-controller@example.test").id;
    otherId = ensureProfileForEmail("other-controller@example.test").id;
    linkEmail("former-controller@example.test", callerId);
  });

  afterAll(async () => {
    await state?.cleanup();
  });

  function seedTarget(name: string, patch: Partial<SessionEntry> = {}) {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:control-" + name };
    const entry: SessionEntry = {
      sessionId: "session-" + name,
      lifecycleRevision: "generation-1",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: otherId },
      ...patch,
    };
    replaceSessionEntrySync(scope, entry);
    return { scope, entry, request: { cfg, ...scope } };
  }

  function assign(
    scope: { agentId: string; sessionKey: string },
    type: "human" | "agent",
    id: string,
  ) {
    expect(
      assignSessionOwner(scope, {
        owner: { type, id },
        assignedBy: { type: "human", id: otherId },
        assignedAt: 1,
      }),
    ).not.toBeNull();
  }

  it.each([
    { relationship: "creator", allowed: true },
    { relationship: "creator-alias", allowed: true },
    { relationship: "human-assignee", allowed: true },
    { relationship: "human-assignee-alias", allowed: true },
    { relationship: "visible-unassigned", allowed: false },
    { relationship: "channel-creator", allowed: false },
    { relationship: "unknown-creator", allowed: false },
    { relationship: "agent-assignee", allowed: false },
    { relationship: "unrelated-admin", allowed: true },
  ] as const)(
    "checks the persisted $relationship relationship",
    async ({ relationship, allowed }) => {
      const createdActor: SessionEntry["createdActor"] =
        relationship === "creator" || relationship === "creator-alias"
          ? {
              type: "human",
              source: "profile",
              id: relationship === "creator" ? callerId : aliasId,
            }
          : relationship === "channel-creator" || relationship === "unknown-creator"
            ? {
                type: "human",
                source: relationship === "channel-creator" ? "channel" : "unknown",
                id: callerId,
              }
            : { type: "human", source: "profile", id: otherId };
      const { scope, entry, request } = seedTarget(relationship, { createdActor });
      if (relationship === "human-assignee" || relationship === "human-assignee-alias") {
        assign(scope, "human", relationship === "human-assignee" ? callerId : aliasId);
      } else if (relationship === "agent-assignee") {
        assign(scope, "agent", callerId);
      }
      const { authority } = issueAuthority(callerId, [
        relationship === "unrelated-admin" ? "operator.admin" : "operator.write",
      ]);
      const pending = prepareSessionControlTarget({ ...request, authority });
      if (!allowed) {
        await expect(pending).rejects.toThrow(/creator or assigned human owner/i);
        return;
      }
      const capture = await pending;
      try {
        expect(capture.sessionId).toBe(entry.sessionId);
        expect(capture.lifecycleRevision).toBe("generation-1");
        expect(() => capture.assertCurrent()).not.toThrow();
      } finally {
        capture.release();
      }
      expect(() => capture.assertCurrent()).toThrow(/facts are unavailable/i);
    },
  );

  it("rejects insufficient, unissued, and stale sources even for the real creator", async () => {
    const { request } = seedTarget("invalid-source", {
      createdActor: { type: "human", source: "profile", id: callerId },
    });
    for (const scopes of [[], ["operator.read"], ["operator.sessions.write"]]) {
      const { authority } = issueAuthority(callerId, scopes);
      await expect(prepareSessionControlTarget({ ...request, authority })).rejects.toThrow(
        "Session controls require operator.write",
      );
    }
    const { authority, revoke } = issueAuthority(callerId);
    await expect(
      prepareSessionControlTarget({ ...request, authority: { ...authority } }),
    ).rejects.toThrow(/issued by the host/i);
    revoke();
    await expect(prepareSessionControlTarget({ ...request, authority })).rejects.toThrow(
      "session control source revoked",
    );
  });

  it("fences a prepared action after reassignment, profile revocation, or source revocation", async () => {
    const { scope, request } = seedTarget("revocation");
    assign(scope, "human", callerId);
    const { authority, revoke } = issueAuthority(callerId);
    const assigned = await prepareSessionControlTarget({ ...request, authority });
    try {
      expect(() => assigned.assertCurrent()).not.toThrow();
      assign(scope, "human", otherId);
      expect(() => assigned.assertCurrent()).toThrow(
        /facts are unavailable|creator or assigned human owner/i,
      );
      await expect(prepareSessionControlTarget({ ...request, authority })).rejects.toThrow(
        /creator or assigned human owner/i,
      );
      assign(scope, "human", callerId);
      // Reassignment can authorize a fresh capture, never revive the already-retired one.
      expect(() => assigned.assertCurrent()).toThrow(/facts are unavailable/i);
    } finally {
      assigned.release();
    }
    const unobserved = await prepareSessionControlTarget({ ...request, authority });
    try {
      assign(scope, "human", otherId);
      assign(scope, "human", callerId);
      expect(() => unobserved.assertCurrent()).toThrow(/facts are unavailable/i);
    } finally {
      unobserved.release();
    }
    const profileCapture = await prepareSessionControlTarget({ ...request, authority });
    try {
      setUserProfileRole(callerId, "reader");
      expect(() => profileCapture.assertCurrent()).toThrow(
        /facts are unavailable|current authenticated profile/i,
      );
    } finally {
      profileCapture.release();
      setUserProfileRole(callerId, null);
    }
    const sourceCapture = await prepareSessionControlTarget({ ...request, authority });
    const { authority: adminAuthority, revoke: revokeAdmin } = issueAuthority(callerId, [
      "operator.admin",
    ]);
    try {
      const adminCapture = await prepareSessionControlTarget({
        ...request,
        authority: adminAuthority,
      });
      try {
        expect(() => sourceCapture.assertCurrent()).not.toThrow();
        expect(() => adminCapture.assertCurrent()).not.toThrow();
        revoke();
        expect(() => sourceCapture.assertCurrent()).toThrow("session control source revoked");
        expect(() => adminCapture.assertCurrent()).not.toThrow();
        revokeAdmin();
        expect(() => adminCapture.assertCurrent()).toThrow("session control source revoked");
      } finally {
        adminCapture.release();
      }
    } finally {
      sourceCapture.release();
    }
  });

  it("binds identity-only captures to the exact session and lifecycle generation", async () => {
    const { scope, entry, request } = seedTarget("identity-only", { lifecycleRevision: undefined });
    // Trusted callers compose their own source guard; omitting it grants no operator capability.
    expect(hasSessionControlAuthority()).toBe(false);
    const initial = await prepareSessionControlTarget({
      ...request,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: null,
    });
    try {
      expect(initial.lifecycleRevision).toBeNull();
      expect(() => initial.assertCurrent()).not.toThrow();
      replaceSessionEntrySync(scope, { ...entry, lifecycleRevision: "reset-generation" });
      expect(() => initial.assertCurrent()).toThrow(/facts are unavailable|target changed/i);
      await expect(
        prepareSessionControlTarget({ ...request, expectedLifecycleRevision: null }),
      ).rejects.toThrow(/target changed/i);
    } finally {
      initial.release();
    }
    const reset = await prepareSessionControlTarget({
      ...request,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: "reset-generation",
    });
    try {
      expect(reset.sessionId).toBe(entry.sessionId);
      expect(() => reset.assertCurrent()).not.toThrow();
      replaceSessionEntrySync(scope, {
        ...entry,
        sessionId: "replacement-session",
        lifecycleRevision: "reset-generation",
      });
      expect(() => reset.assertCurrent()).toThrow(/facts are unavailable|target changed/i);
      await expect(
        prepareSessionControlTarget({ ...request, expectedSessionId: entry.sessionId }),
      ).rejects.toThrow(/target changed/i);
    } finally {
      reset.release();
    }
    const replacement = await prepareSessionControlTarget({
      ...request,
      expectedSessionId: "replacement-session",
      expectedLifecycleRevision: "reset-generation",
    });
    try {
      expect(() => replacement.assertCurrent()).not.toThrow();
    } finally {
      replacement.release();
    }
    expect(() => replacement.assertCurrent()).toThrow(/facts are unavailable/i);
  });
});
