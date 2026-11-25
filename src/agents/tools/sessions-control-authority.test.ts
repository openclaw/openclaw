import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "../../config/sessions/session-accessor.sqlite-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { prepareSessionControlTarget } from "./sessions-control-authority.js";
import {
  captureSessionControlAuthority,
  hasSessionControlAuthority,
} from "./sessions-operator-authority.js";
import { createSessionsTool } from "./sessions-tool.js";

function issueAuthority(profileId: string, scopes: readonly string[] = ["operator.write"]) {
  const controller = new AbortController();
  const authority = createTestOperatorAuthority({
    profileId,
    scopes,
    signal: controller.signal,
  });
  return {
    authority,
    revoke: () => controller.abort(new Error("session control source revoked")),
  };
}

type Capture = Awaited<ReturnType<typeof prepareSessionControlTarget>>;
async function withCapture(
  request: Parameters<typeof prepareSessionControlTarget>[0],
  check: (capture: Capture) => void | Promise<void>,
) {
  const capture = await prepareSessionControlTarget(request);
  try {
    await check(capture);
  } finally {
    capture.release();
  }
  return capture;
}

describe("session control source capability", () => {
  it("never mints authority from absence, matching fields, or a copy", () => {
    expect(captureSessionControlAuthority()?.authority).toBeUndefined();
    expect(hasSessionControlAuthority()).toBe(false);
    const { authority } = issueAuthority("control-profile");
    const forged: AdmittedRunOperatorAuthority = {
      canonicalIdentity: null,
      profileId: authority.profileId,
      scopes: authority.scopes,
      grant: authority.grant,
    };
    for (const unissued of [forged, { ...authority }]) {
      expect(() => captureSessionControlAuthority(unissued)).toThrow(/issued by the host/i);
      expect(() => hasSessionControlAuthority(unissued)).toThrow(/issued by the host/i);
    }
  });

  it("resolves the ambient original but rejects an unrelated prepared upgrade", async () => {
    const { authority } = issueAuthority("control-profile", ["operator.read"]);
    const { authority: upgrade } = issueAuthority("control-profile", ["operator.admin"]);
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:dashboard:caller", operatorAuthority: authority },
      () => {
        expect(captureSessionControlAuthority()?.authority).toBe(authority);
        expect(hasSessionControlAuthority()).toBe(false);
        expect(() => hasSessionControlAuthority(upgrade)).toThrow(/source changed/i);
      },
    );
  });

  const ambientScope = (authority: AdmittedRunOperatorAuthority) => ({
    isWebchatConnect: () => false,
    client: createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "operator", profileId: "control-profile" },
      operatorRunAuthority: authority,
      scopes: ["operator.write"],
    }),
  });

  it("keeps a completed request's client out of an admitted run's session controls", () => {
    const { authority: ambient, revoke } = issueAuthority("control-profile");
    const { authority: admitted } = issueAuthority("control-profile");
    revoke();
    withPluginRuntimeGatewayRequestScope(ambientScope(ambient), () => {
      expect(hasSessionControlAuthority(admitted)).toBe(true);
    });
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
    return { scope, entry, request: { cfg, ...scope, operation: "stop" as const } };
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
    { relationship: "human-assignee-alias", allowed: true },
    { relationship: "channel-creator", allowed: false },
    { relationship: "agent-assignee", allowed: false },
    { relationship: "unrelated-admin", allowed: true },
  ] as const)(
    "checks the persisted $relationship relationship",
    async ({ relationship, allowed }) => {
      const createdActor: SessionEntry["createdActor"] = {
        type: "human",
        source: relationship === "channel-creator" ? "channel" : "profile",
        id: ["creator", "channel-creator"].includes(relationship) ? callerId : otherId,
      };
      const { scope, entry, request } = seedTarget(relationship, { createdActor });
      if (relationship === "human-assignee-alias") {
        assign(scope, "human", aliasId);
      } else if (relationship === "agent-assignee") {
        assign(scope, "agent", callerId);
      }
      const { authority } = issueAuthority(callerId, [
        relationship === "unrelated-admin" ? "operator.admin" : "operator.write",
      ]);
      if (!allowed) {
        await expect(prepareSessionControlTarget({ ...request, authority })).rejects.toThrow(
          /creator or assigned human owner/i,
        );
        return;
      }
      const capture = await withCapture({ ...request, authority }, (current) => {
        expect(current).toMatchObject({
          sessionId: entry.sessionId,
          lifecycleRevision: "generation-1",
        });
        expect(current.assertCurrent).not.toThrow();
      });
      expect(capture.assertCurrent).toThrow(/facts are unavailable/i);
    },
  );

  it("rejects insufficient and unissued sources even for the real creator", async () => {
    const { request } = seedTarget("invalid-source", {
      createdActor: { type: "human", source: "profile", id: callerId },
    });
    for (const scopes of [[], ["operator.read"], ["operator.sessions.write"]]) {
      const { authority } = issueAuthority(callerId, scopes);
      await expect(prepareSessionControlTarget({ ...request, authority })).rejects.toThrow(
        "Session controls require operator.write",
      );
    }
    const { authority } = issueAuthority(callerId);
    await expect(
      prepareSessionControlTarget({ ...request, authority: { ...authority } }),
    ).rejects.toThrow(/issued by the host/i);
  });

  it("rejects an assignee's self-archive before reporting it as scheduled", async () => {
    const { scope, entry } = seedTarget("assignee-self-archive");
    assign(scope, "human", callerId);
    const { authority } = issueAuthority(callerId);
    const admission = await beginSessionEffect({
      scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: scope.agentId }),
      identities: [scope.sessionKey, entry.sessionId],
      assertAllowed: () => {},
    });
    const tool = createSessionsTool({
      agentSessionKey: scope.sessionKey,
      agentSessionId: entry.sessionId,
      senderIsOwner: false,
      sessionControlAuthority: authority,
      config: cfg,
    });
    try {
      await expect(
        withGatewayToolCallerIdentity({ ...scope, operatorAuthority: authority }, () =>
          tool.execute("archive-assigned", { action: "patch", archived: true }),
        ),
      ).rejects.toThrow(/session creator/i);
    } finally {
      admission.release();
    }
  });

  it("fences a prepared action after reassignment", async () => {
    const { scope, request } = seedTarget("revocation");
    assign(scope, "human", callerId);
    const { authority } = issueAuthority(callerId);
    const authorized = { ...request, authority };
    await withCapture(authorized, async (assigned) => {
      expect(assigned.assertCurrent).not.toThrow();
      assign(scope, "human", otherId);
      expect(assigned.assertCurrent).toThrow(
        /facts are unavailable|creator or assigned human owner/i,
      );
      await expect(prepareSessionControlTarget(authorized)).rejects.toThrow(
        /creator or assigned human owner/i,
      );
      assign(scope, "human", callerId);
      // Reassignment can authorize a fresh capture, never revive the already-retired one.
      expect(assigned.assertCurrent).toThrow(/facts are unavailable/i);
    });
    await withCapture(authorized, (unobserved) => {
      assign(scope, "human", otherId);
      assign(scope, "human", callerId);
      expect(unobserved.assertCurrent).toThrow(/facts are unavailable/i);
    });
  });

  // Admitted once: a role change after the turn started applies to the caller's next turn.
  it("keeps the admitted role for a prepared action after a role change", async () => {
    const { scope, request } = seedTarget("role-change");
    assign(scope, "human", callerId);
    const { authority } = issueAuthority(callerId);
    try {
      await withCapture({ ...request, authority }, (capture) => {
        setUserProfileRole(callerId, "reader");
        expect(capture.assertCurrent).not.toThrow();
      });
    } finally {
      setUserProfileRole(callerId, null);
    }
  });

  it("binds identity-only captures to the exact session and lifecycle generation", async () => {
    const { scope, entry, request } = seedTarget("identity-only", { lifecycleRevision: undefined });
    // Trusted callers compose their own source guard; omitting it grants no operator capability.
    expect(hasSessionControlAuthority()).toBe(false);
    for (const [before, after] of [
      [entry, { ...entry, lifecycleRevision: "reset-generation" }],
      [
        { ...entry, lifecycleRevision: "reset-generation" },
        { ...entry, sessionId: "replacement-session", lifecycleRevision: "reset-generation" },
      ],
    ] as const) {
      const expected = {
        expectedSessionId: before.sessionId,
        expectedLifecycleRevision: before.lifecycleRevision ?? null,
      };
      await withCapture({ ...request, ...expected }, async (capture) => {
        expect(capture).toMatchObject({
          sessionId: before.sessionId,
          lifecycleRevision: before.lifecycleRevision ?? null,
        });
        expect(capture.assertCurrent).not.toThrow();
        replaceSessionEntrySync(scope, after);
        expect(capture.assertCurrent).toThrow(/facts are unavailable|target changed/i);
        const mismatch =
          before.sessionId === after.sessionId
            ? { expectedLifecycleRevision: expected.expectedLifecycleRevision }
            : { expectedSessionId: expected.expectedSessionId };
        await expect(prepareSessionControlTarget({ ...request, ...mismatch })).rejects.toThrow(
          /target changed/i,
        );
      });
    }
    const replacement = await withCapture(
      {
        ...request,
        expectedSessionId: "replacement-session",
        expectedLifecycleRevision: "reset-generation",
      },
      (capture) => {
        expect(capture.assertCurrent).not.toThrow();
      },
    );
    expect(replacement.assertCurrent).toThrow(/facts are unavailable/i);
  });
});
