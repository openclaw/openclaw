import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { recordCommittedSessionMetadataPublication } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionActionV2,
} from "./github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSession: vi.fn<typeof import("../session-utils.js").loadGatewaySessionEntryReadOnly>(),
  roleScopes: undefined as string[] | undefined,
}));

// mock-isolation: Throw on legacy synchronous reads so publication tests enforce the async storage boundary.
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: () => {
    throw new Error("Synchronous publication read");
  },
}));
// mock-isolation: Publication fixtures supply selected rows and source identity without starting storage.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async ({
    key,
    agentId,
    onSelected,
  }: Parameters<
    typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
  >[0]) => {
    const loaded = mocks.loadSession(key, { agentId });
    onSelected?.({
      ...loaded,
      store: loaded.entry ? { [loaded.canonicalKey]: loaded.entry } : {},
      capturedReadSource: {
        agentId: loaded.agentId,
        path: loaded.storePath,
        databaseIdentity: "github-options-fixture",
        databaseBirthtime: "1",
      },
    });
    return loaded;
  },
}));
// mock-isolation: Publication requester admission does not open profile or session stores here.
vi.mock("../github-publication-requester.js", () => ({
  prepareGitHubPublicationRequesterV2: async () => ({
    requester: {
      signal: new AbortController().signal,
      prepareSource: () => {
        throw new Error("Publication source preparation is outside this authorization test.");
      },
    },
    release: () => {},
  }),
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
// mock-isolation: Options disclosure uses synthetic profile authority without opening the host profile store.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRolePolicyAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
}));
// mock-isolation: Authorization policy fixtures do not open or hydrate the profile database.
vi.mock("../../state/user-profile-list.js", () => ({
  captureResidentUserProfileAccess: (profileId: string) => ({
    assertCurrent: () => ({ id: profileId, role: null }),
  }),
}));
vi.mock("../operator-role-policy.js", () => ({
  resolveOperatorRolePolicy: () => (mocks.roleScopes ? { scopes: mocks.roleScopes } : null),
  resolveOperatorRolePolicyForProfile: () =>
    mocks.roleScopes ? { scopes: mocks.roleScopes } : null,
  resolveOperatorRolePolicyForAssignment: () =>
    mocks.roleScopes ? { scopes: mocks.roleScopes } : null,
}));
// mock-isolation: Selected-session authorization is supplied directly, without initializing sharing storage.
vi.mock("../session-sharing.js", () => ({
  createSessionListEntryFilter: () => undefined,
}));

// mock-isolation: Session sharing is admitted independently of the live personal grant checked here.
vi.mock("../session-sharing-authorization-async.js", () => ({
  resolveSessionMutationAuthorizationAsync: async () => ({}),
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

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
});

describe("GitHub publication request discovery", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    mocks.roleScopes = undefined;
    mocks.loadSession.mockReset();
    mocks.loadSession.mockReturnValue(sessionRead());
  });

  it("keeps origin-free personal reads and publication bound to the live ingress grant", async () => {
    const request = createRequest();
    const grant = new AbortController();
    const principal = createRemoteControlUiIngressTestContext({
      principal: { kind: "person", profileId: "profile-cache-test" },
      signal: grant.signal,
    }).resolvePrincipal();
    delete request.client.connId;
    request.client.authenticatedUserProfile = principal.authenticatedUserProfile;
    request.client.internal = {
      remoteIngressPrincipal: principal,
      operatorRoleActor: principal.operatorRoleActor,
    };
    request.context.getClientConnIds = () => new Set();
    const read = await prepareGitHubPublicationOptionsRead(request, { sessionKey: "main" });
    releases.push(read.release);
    expect(read.personal.kind).toBe("eligible");
    const publication = await preparePersonalGitHubSessionActionV2(request, {
      sessionKey: "main",
    });
    try {
      expect(() => publication.action.assertCurrent()).not.toThrow();
      grant.abort();
      expect(() => read.currentSession()).toThrow("connection is no longer current");
      expect(() => publication.action.assertCurrent()).toThrow("current authenticated human");
    } finally {
      publication.release();
    }
  });

  it.each([
    ["operator.read", "operator.sessions.write"],
    ["operator.sessions.write", "operator.read"],
  ])("retains shared session-read permission for %s capped by %s", async (grant, ceiling) => {
    const request = createRequest();
    request.client.connect.scopes = [grant];
    mocks.roleScopes = [ceiling];

    const read = await prepareGitHubPublicationOptionsRead(request, { sessionKey: "main" });
    releases.push(read.release);
    expect(read.currentSession()).toEqual(read.session);
    expect(read.personal.kind).toBe("ineligible");

    mocks.roleScopes = ["operator.approvals"];
    expect(() => read.currentSession()).toThrow(
      "GitHub requires current operator.sessions.read permission.",
    );
  });

  it("reuses the worker result until publication metadata changes", async () => {
    const agentId = "research";
    const loaded = sessionRead(agentId);
    mocks.loadSession.mockReturnValue(loaded);
    const read = await prepareGitHubPublicationOptionsRead(createRequest(), {
      sessionKey: "main",
      agentId,
    });
    releases.push(read.release);
    expect(read.currentSession()).toEqual(read.session);
    recordCommittedSessionMetadataPublication(
      "github-options-fixture",
      loaded.canonicalKey,
      undefined,
      { ...loaded.entry, label: "renamed" },
    );
    expect(read.currentSession()).toEqual(read.session);
    expect(mocks.loadSession).toHaveBeenCalledTimes(1);
    read.release();
    expect(() => read.currentSession()).toThrow("session lifecycle changed");
  });

  it.each([null, 123])(
    "invalidates a prepared response after an archive receipt from %s",
    async (archivedAt) => {
      const loaded = sessionRead();
      mocks.loadSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: archivedAt ?? undefined },
      });
      const read = await prepareGitHubPublicationOptionsRead(createRequest(), {
        sessionKey: "main",
      });
      releases.push(read.release);
      const initial = read.currentSession();
      expect(initial.archivedAt).toBe(archivedAt);
      recordCommittedSessionMetadataPublication(
        "github-options-fixture",
        loaded.canonicalKey,
        undefined,
        {
          ...loaded.entry,
          archivedAt: archivedAt === null ? 123 : undefined,
        },
      );
      expect(() => read.currentSession()).toThrow("session lifecycle changed");
      expect(() => read.assertSessionUnchanged(initial)).toThrow("session lifecycle changed");
    },
  );
});
