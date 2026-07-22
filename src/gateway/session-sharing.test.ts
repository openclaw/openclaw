import { describe, expect, it } from "vitest";
import type { GatewayClient } from "./server-methods/types.js";
import {
  allowedSessionVisibilities,
  authorizeSessionMutation,
  canReceiveSessionEvent,
  canMutateSession,
  filterDraftSessionsForClient,
  resolveGatewayConnectionIdentity,
  resolveSessionCreator,
  resolveSessionMutationTarget,
  resolveSessionSharingRole,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing.js";

function client(params: {
  user?: string;
  deviceId?: string;
  displayName?: string;
  scopes?: string[];
}): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
        ...(params.displayName ? { displayName: params.displayName } : {}),
      },
      role: "operator",
      scopes: params.scopes ?? ["operator.read", "operator.write"],
      ...(params.deviceId
        ? {
            device: {
              id: params.deviceId,
              publicKey: "key",
              signature: "signature",
              signedAt: 1,
              nonce: "nonce",
            },
          }
        : {}),
    },
    ...(params.user ? { authenticatedUserId: params.user } : {}),
  };
}

function target(createdBy?: { id: string; label?: string }): SessionSharingTarget {
  return {
    agentId: "main",
    canonicalKey: "agent:main:main",
    entry: {
      sessionId: "session-main",
      updatedAt: 1,
      visibility: "draft",
      ...(createdBy ? { createdBy } : {}),
    },
    storePath: "/tmp/sessions.json",
  };
}

describe("session sharing policy", () => {
  it("keeps identity-less solo mode owner-equivalent for restricted sessions", () => {
    const role = resolveSessionSharingRole({ client: client({}), target: target() });
    expect(role).toBe("owner");
    expect(canMutateSession({ role, visibility: "draft" })).toBe(true);
  });

  it("uses trusted-proxy identity before the paired-device label fallback", () => {
    expect(
      resolveGatewayConnectionIdentity(
        client({ user: "alice@example.com", deviceId: "device-1", displayName: "Alice's Mac" }),
      ),
    ).toEqual({ id: "alice@example.com" });
    expect(
      resolveGatewayConnectionIdentity(
        client({ deviceId: "device-1", displayName: "Alice's Mac" }),
      ),
    ).toEqual({ id: "device-1", label: "Alice's Mac" });
  });

  it("reads W1 createdBy structurally and hides drafts from other identified operators", () => {
    const owner = client({ user: "owner@example.com" });
    const viewer = client({ user: "viewer@example.com" });
    const entry = {
      sessionId: "session-main",
      updatedAt: 1,
      visibility: "draft" as const,
      createdBy: { id: "owner@example.com", label: "Owner" },
    };
    expect(resolveSessionCreator(entry)).toEqual({ id: "owner@example.com", label: "Owner" });
    expect(filterDraftSessionsForClient({ client: owner, store: { main: entry } })).toHaveProperty(
      "main",
    );
    expect(filterDraftSessionsForClient({ client: viewer, store: { main: entry } })).toEqual({});
  });

  it("defaults legacy entries and omitted policy flags to enabled", () => {
    expect(resolveSessionVisibility({})).toBe("shared");
    expect(allowedSessionVisibilities({})).toEqual(["shared", "read-only", "suggest", "draft"]);
    expect(allowedSessionVisibilities({ session: { sharing: { suggest: false } } })).toEqual([
      "shared",
      "read-only",
      "draft",
    ]);
  });

  it("keeps agent scope with indirect run and approval targets", () => {
    const context = {
      chatAbortControllers: new Map([["run-1", { sessionKey: "global", agentId: "work" }]]),
      execApprovalManager: {
        lookupApprovalId: () => ({ kind: "exact", id: "approval-1" }),
        getSnapshot: () => ({ request: { sessionKey: "global", agentId: "work" } }),
      },
    } as never;
    expect(
      resolveSessionMutationTarget({
        cfg: {},
        method: "sessions.abort",
        requestParams: { runId: "run-1" },
        context,
      }),
    ).toEqual({ sessionKey: "global", agentId: "work" });
    expect(
      resolveSessionMutationTarget({
        cfg: {},
        method: "exec.approval.resolve",
        requestParams: { id: "approval-1" },
        context,
      }),
    ).toEqual({ sessionKey: "global", agentId: "work" });
  });

  it("fails closed when a required session mutation has no target", () => {
    const context = { chatAbortControllers: new Map() } as never;
    expect(
      authorizeSessionMutation({
        cfg: {},
        client: client({}),
        method: "sessions.reset",
        requestParams: {},
        context,
      }),
    ).toMatchObject({ details: { code: "SESSION_MUTATION_TARGET_REQUIRED" } });
    expect(
      authorizeSessionMutation({
        cfg: {},
        client: client({ scopes: ["operator.admin"] }),
        method: "sessions.reset",
        requestParams: {},
        context,
      }),
    ).toBeNull();
  });

  it("fails closed for scoped events whose session row was deleted", () => {
    expect(
      canReceiveSessionEvent({
        cfg: {},
        client: client({ user: "viewer@example.com" }) as never,
        sessionKeys: ["agent:main:deleted-draft"],
      }),
    ).toBe(false);
  });
});
