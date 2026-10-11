import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionAction,
} from "./github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSession: vi.fn<typeof import("../session-utils.js").loadGatewaySessionEntryReadOnly>(),
  roleScopes: undefined as string[] | undefined,
}));

vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
// mock-isolation: Exercise request permissions without opening profile storage.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRolePolicyAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
}));
vi.mock("../../state/user-github-connections.js", () => ({
  resolvePersonalGitHubOwner: (profile: string) => profile,
}));
vi.mock("../operator-role-policy.js", () => ({
  resolveOperatorRolePolicy: () => (mocks.roleScopes ? { scopes: mocks.roleScopes } : null),
  resolveOperatorRolePolicyForProfile: () =>
    mocks.roleScopes ? { scopes: mocks.roleScopes } : null,
  resolveOperatorRolePolicyForAssignment: () =>
    mocks.roleScopes ? { scopes: mocks.roleScopes } : null,
}));
vi.mock("../session-sharing.js", () => ({
  createSessionListEntryFilter: () => undefined,
  resolveSessionMutationAuthorization: () => ({}),
}));

function createRequest() {
  const client: GatewayClient = {
    connId: "github-cache-client",
    authenticatedUserProfile: {
      profileId: "profile-cache-test",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  const context = {
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(!filter || filter(client) ? ["github-cache-client"] : []),
  } as Partial<GatewayRequestContext> as GatewayRequestContext;
  return {
    client,
    context,
    req: { type: "req" as const, id: "github-read", method: "sessions.github.options" },
  };
}

function sessionRead(agentId = "main") {
  return {
    cfg: {},
    canonicalKey: `agent:${agentId}:main`,
    agentId,
    storePath: "/test/sessions.json",
    store: {},
    storeKeys: [`agent:${agentId}:main`],
    entry: { sessionId: "session-cache-test", updatedAt: 1 },
    legacyKey: undefined,
  };
}

describe("GitHub publication request discovery", () => {
  beforeEach(() => {
    mocks.roleScopes = undefined;
    mocks.loadSession.mockReset();
    mocks.loadSession.mockReturnValue(sessionRead());
  });

  it.each([
    ["operator.read", "operator.sessions.write"],
    ["operator.sessions.write", "operator.read"],
  ])("retains shared session-read permission for %s capped by %s", async (grant, ceiling) => {
    const request = createRequest();
    request.client.connect.scopes = [grant];
    mocks.roleScopes = [ceiling];

    const read = await prepareGitHubPublicationOptionsRead(request, { sessionKey: "main" });
    expect(read.currentSession()).toEqual(read.session);
    expect(read.personal.kind).toBe("ineligible");

    mocks.roleScopes = ["operator.approvals"];
    expect(() => read.currentSession()).toThrow(
      "GitHub requires current operator.sessions.read permission.",
    );
  });

  it("shares store discovery while re-reading publication options live", async () => {
    const agentId = "research";
    mocks.loadSession.mockReturnValue(sessionRead(agentId));
    const read = await prepareGitHubPublicationOptionsRead(createRequest(), {
      sessionKey: "main",
      agentId,
    });

    expect(read.currentSession()).toEqual(read.session);
    expect(mocks.loadSession).toHaveBeenCalledTimes(2);
    const targetDiscoveryCache = mocks.loadSession.mock.calls[0]?.[1]?.targetDiscoveryCache;
    expect(targetDiscoveryCache).toBeInstanceOf(Map);
    expect(mocks.loadSession).toHaveBeenNthCalledWith(1, "main", {
      agentId,
      targetDiscoveryCache,
    });
    expect(mocks.loadSession.mock.calls[1]?.[1]?.targetDiscoveryCache).toBe(targetDiscoveryCache);
    expect(mocks.loadSession).toHaveBeenNthCalledWith(2, `agent:${agentId}:main`, {
      agentId,
      targetDiscoveryCache,
    });
  });

  it.each([null, 123])(
    "keeps each response archive snapshot immutable from %s",
    async (archivedAt) => {
      const loaded = sessionRead();
      mocks.loadSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: archivedAt ?? undefined },
      });
      const read = await prepareGitHubPublicationOptionsRead(createRequest(), {
        sessionKey: "main",
      });
      const initial = read.currentSession();
      const changedAt = archivedAt === null ? 123 : null;
      mocks.loadSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: changedAt ?? undefined },
      });
      const changed = read.currentSession();
      expect(changed.archivedAt).toBe(changedAt);
      expect(() => read.assertSessionUnchanged(changed)).not.toThrow();
      expect(() => read.assertSessionUnchanged(initial)).toThrow("session access changed");

      mocks.loadSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: archivedAt ?? undefined },
      });
      const restored = read.currentSession();
      expect(restored.archivedAt).toBe(archivedAt);
      expect(() => read.assertSessionUnchanged(changed)).toThrow("session access changed");
      expect(() => read.assertSessionUnchanged(restored)).not.toThrow();
    },
  );

  it("shares store discovery across every personal session authority re-read", () => {
    const agentId = "research";
    mocks.loadSession.mockReturnValue(sessionRead(agentId));
    const action = preparePersonalGitHubSessionAction(createRequest(), {
      sessionKey: "main",
      agentId,
    });
    action.assertCurrent();

    expect(mocks.loadSession).toHaveBeenCalledTimes(3);
    const targetDiscoveryCache = mocks.loadSession.mock.calls[0]?.[1]?.targetDiscoveryCache;
    expect(targetDiscoveryCache).toBeInstanceOf(Map);
    expect(mocks.loadSession).toHaveBeenNthCalledWith(1, "main", {
      agentId,
      targetDiscoveryCache,
    });
    for (const call of [2, 3]) {
      expect(mocks.loadSession.mock.calls[call - 1]?.[1]?.targetDiscoveryCache).toBe(
        targetDiscoveryCache,
      );
      expect(mocks.loadSession).toHaveBeenNthCalledWith(call, `agent:${agentId}:main`, {
        agentId,
        targetDiscoveryCache,
      });
    }
  });
});
