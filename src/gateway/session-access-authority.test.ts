import { renameSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import * as profileReader from "../state/user-profile-list.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
} from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import * as sessionAccess from "./session-access-authority.js";
import { prepareGatewaySessionAccessAuthority } from "./session-access-authority.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareIdentity:
    vi.fn<typeof import("../state/user-profile-list.js").prepareUserProfileIdentity>(),
  profileLeases: new Set<object>(),
  toolAllowed: true,
  sandboxRequired: false,
  sandboxed: false,
  ambient: undefined as unknown,
  assertAmbient: vi.fn(),
}));
vi.mock("../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: mocks.prepare,
}));
vi.mock("../agents/tools/gateway-caller-context.js", async (original) => ({
  ...(await original<typeof import("../agents/tools/gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: () => mocks.ambient,
  captureGatewayToolCallerAssertion: () => mocks.assertAmbient,
}));
vi.mock("./session-resource-tool-policy.js", () => ({
  resolveSessionResourceToolPolicy: () => {
    if (!mocks.toolAllowed) {
      throw new Error("tool denied");
    }
    return { sandboxRequired: mocks.sandboxRequired, sandboxed: mocks.sandboxed };
  },
}));

const key = "agent:main:dashboard:review";
const method = "fixture.session.open";
const query = { agentId: "main", key };
const sessionEntry = (creator = "alice"): SessionEntry => ({
  sessionId: "session-1",
  lifecycleRevision: "incarnation-1",
  updatedAt: 1,
  createdActor: { type: "human", source: "profile", id: creator },
  visibility: "shared",
});
const held: Array<{ release: () => void }> = [];
function hold<T extends { release: () => void }>(value: T): T {
  held.push(value);
  return value;
}

function fixture(scopes = ["operator.write"], creator = "someone-else") {
  const grant = new AbortController();
  let entry = sessionEntry(creator);
  const generation = Symbol("database");
  const client = {
    connect: { role: "operator", scopes, client: { id: "test", mode: "webchat" } },
    authenticatedUserProfile: { profileId: "alice", displayName: "Alice" },
    internal: {
      operatorAccessAuthority: {
        signal: grant.signal,
        assertCurrent: () => grant.signal.throwIfAborted(),
      },
    },
  } as GatewayClient;
  const context = bindSessionRowProjection(createContext(), () => projection);
  const projection = {
    prepareMembership: async () => {},
    sharingTarget: () => ({
      agentId: "main",
      canonicalKey: key,
      entry,
      generation,
      storePath: "/test/sessions",
      storeKey: key,
      storeKeys: [key],
    }),
    hasMembership: () => false,
    sharingTargetState: () => {
      const target = projection.sharingTarget(query);
      return { status: "ready", target };
    },
  } as unknown as SessionRowProjection;
  return {
    grant,
    client,
    context,
    projection,
    setVisibility(visibility: SessionEntry["visibility"]) {
      entry = { ...entry, updatedAt: 2, visibility };
    },
    prepare: () => prepareAuthority({ context, client }),
  };
}

async function prepareAuthority({
  context,
  client,
}: {
  context: GatewayRequestContext;
  client: GatewayClient;
}) {
  const { authority } = await prepareGatewaySessionAccessAuthority({
    policy: { mode: "write", requiredTool: "browser", allowOwnSessionScope: true },
    requestParams: { sessionKey: key, agentId: "main" },
    context,
    client,
    ownSessionOnly: false,
  });
  return hold(authority);
}

function descriptor(handler: GatewayRequestHandler, allowOwnSessionScope?: boolean) {
  return createPluginGatewayMethodDescriptor({
    pluginId: "fixture",
    name: method,
    handler,
    scope: "operator.write",
    sessionAccess: { mode: "write", requiredTool: "browser", allowOwnSessionScope },
  });
}

async function retainedResource() {
  const test = fixture();
  const authority = await test.prepare();
  const resource = hold(authority.retainSession());
  authority.release();
  const readyState = test.projection.sharingTargetState(query);
  const state = vi
    .spyOn(test.projection, "sharingTargetState")
    .mockReturnValue({ status: "pending" });
  return { test, resource, readyState, state };
}

function expectCurrent(...authorities: Array<{ assertCurrent: () => void }>) {
  for (const authority of authorities) {
    expect(() => authority.assertCurrent()).not.toThrow();
  }
}

async function borrowSession(test = fixture()) {
  const authority = await prepareAuthority(test);
  return { authority, viewer: hold(authority.retain()), resource: hold(authority.retainSession()) };
}

function renewGrant(test: ReturnType<typeof fixture>) {
  test.client.internal!.operatorAccessAuthority = {
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
}

async function withStoredSession(
  run: (
    test: ReturnType<typeof fixture>,
    scope: { agentId: string; sessionKey: string; storePath: string },
    state: OpenClawTestState,
  ) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const heldStart = held.length;
    const scope = {
      agentId: "main",
      sessionKey: key,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    const cfg = { agents: { entries: { main: {} } }, session: { store: scope.storePath } };
    setRuntimeConfigSnapshot(cfg);
    await replaceSessionEntry(scope, sessionEntry());
    const test = fixture();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection(
      { ...test.context, getRuntimeConfig: () => cfg },
      () => projection,
    );
    try {
      await projection.ensureMaterialized();
      await run({ ...test, context, projection }, scope, state);
    } finally {
      for (const authority of held.splice(heldStart)) {
        authority.release();
      }
      projection.dispose();
    }
  });
}

function dispatchSession(
  test: ReturnType<typeof fixture>,
  handler: GatewayRequestHandler,
  options: Partial<
    Pick<
      Parameters<typeof handleGatewayRequest>[0],
      "respond" | "sessionMutationCommitGuard" | "expectedProfileBinding"
    >
  > & { allowOwnSessionScope?: boolean } = {},
) {
  const { allowOwnSessionScope, ...request } = options;
  return handleGatewayRequest({
    req: { type: "req", id: "session-access", method, params: { sessionKey: key } },
    respond: vi.fn(),
    client: test.client,
    context: test.context,
    methodRegistry: createGatewayMethodRegistry([descriptor(handler, allowOwnSessionScope)]),
    isWebchatConnect: () => false,
    ...request,
  });
}

beforeEach(() => {
  mocks.toolAllowed = true;
  mocks.sandboxRequired = false;
  mocks.sandboxed = false;
  mocks.ambient = undefined;
  mocks.assertAmbient.mockReset();
  mocks.prepareIdentity.mockReset().mockImplementation(async (profileId) => {
    const lease = {};
    mocks.profileLeases.add(lease);
    const readCurrentProfile = () => {
      if (!mocks.profileLeases.has(lease)) {
        throw new Error("Prepared profile lease was released");
      }
      return { profileId, assignedRole: null };
    };
    return {
      readCurrentProfile,
      emailBindingIds: [],
      readCurrentFacts: () => ({
        profile: { ...readCurrentProfile(), emails: [] },
        aliases: new Set([profileId]),
      }),
      release: () => {
        mocks.profileLeases.delete(lease);
      },
    };
  });
  vi.spyOn(profileReader, "prepareUserProfileIdentity").mockImplementation(mocks.prepareIdentity);
  mocks.prepare.mockReset().mockImplementation(async () => ({
    profileId: "alice",
    role: null,
    aliases: ["alice", "former-alice"],
    isCurrent: () => true,
  }));
});
afterEach(() => {
  for (const authority of held.splice(0)) {
    authority.release();
  }
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
  expect(mocks.profileLeases.size).toBe(0);
});

describe("session resource admission", () => {
  it.each([
    ["canonical", "grant"],
    ["canonical", "profile"],
    ["canonical", "scope"],
    ["aliases", "grant"],
  ] as const)(
    "refuses a replaced %s preparation %s before route effects",
    async (stage, change) => {
      const test = fixture();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const pause = async <T>(profile: T) => {
        entered.resolve();
        await resume.promise;
        return profile;
      };
      if (stage === "canonical") {
        const prepare = expectDefined(
          mocks.prepareIdentity.getMockImplementation(),
          "profile fixture",
        );
        mocks.prepareIdentity.mockImplementationOnce(async (...args) =>
          pause(await prepare(...args)),
        );
      } else {
        const prepare = expectDefined(mocks.prepare.getMockImplementation(), "alias fixture");
        mocks.prepare.mockImplementationOnce(async (...args) => pause(await prepare(...args)));
      }
      const handler = vi.fn<GatewayRequestHandler>(({ sessionAccessAuthority, respond }) => {
        expectDefined(sessionAccessAuthority, "registered session authority").assertCurrent();
        respond(true, {});
      });
      const respond = vi.fn();
      const pending = dispatchSession(test, handler, { respond });
      const failure = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([entered.promise, pending]);
        expect(mocks.profileLeases.size).toBe(1);
        if (change === "grant") {
          renewGrant(test);
        } else if (change === "profile") {
          test.client.authenticatedUserProfile = {
            ...expectDefined(test.client.authenticatedUserProfile, "original profile"),
            profileId: "replacement-profile",
          };
        } else {
          test.client.connect.scopes = ["operator.read"];
        }
        resume.resolve();
        const thrown = await failure;
        expect(handler).not.toHaveBeenCalled();
        expect(
          thrown instanceof Error ? thrown.message : respond.mock.calls[0]?.[2]?.message,
        ).toMatch(
          stage === "aliases" ? "Session access changed" : /authority|Session access changed/,
        );
        expect(mocks.profileLeases.size).toBe(0);
      } finally {
        resume.resolve();
        await failure;
      }
    },
  );

  it.each(["identity", "scope"])(
    "captures the canonical profile before alias preparation and fences a later operator %s change",
    async (kind) => {
      const test = fixture();
      const profile = test.client.authenticatedUserProfile;
      delete test.client.authenticatedUserProfile;
      test.client.authenticatedUserId = "original-operator";
      test.client.authenticatedGitHubIdentitySync = vi.fn(async () => {
        await Promise.resolve();
        test.client.authenticatedUserProfile = profile;
        return { profileId: "alice", updatedAt: 1 };
      });
      const effect = vi.fn();
      const handler = vi.fn<GatewayRequestHandler>(async ({ sessionAccessAuthority, respond }) => {
        const authority = sessionAccessAuthority!;
        const resource = hold(authority.retainSession());
        authority.assertCurrent();
        await Promise.resolve();
        if (kind === "identity") {
          test.client.authenticatedUserId = "changed-operator";
        } else {
          test.client.connect.scopes = [];
        }
        expect(() => {
          authority.assertCurrent();
          effect();
        }).toThrow("Gateway requester authority changed");
        expect(() => resource.assertCurrent()).not.toThrow();
        respond(true, {});
      });
      await dispatchSession(test, handler);
      expect(test.client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { scopes: ["operator.read"], reason: "removed scope" },
    { scopes: ["operator.sessions.write"], reason: "changed admission alternative" },
  ])("releases prepared authority after final $reason denial", async ({ scopes }) => {
    const test = fixture(["operator.write", "operator.sessions.write"], "alice");
    const prepare = sessionAccess.prepareGatewaySessionAccessAuthority;
    const release = vi.fn();
    using capture = vi
      .spyOn(sessionAccess, "prepareGatewaySessionAccessAuthority")
      .mockImplementation(async (params) => {
        const prepared = await prepare(params);
        const authority = prepared.authority;
        release.mockImplementation(authority.release);
        return {
          ...prepared,
          assertPreparationCurrent: () => {
            prepared.assertPreparationCurrent();
            test.client.connect.scopes = scopes;
          },
          authority: { ...authority, release },
        };
      });
    const handler = vi.fn<GatewayRequestHandler>();
    const respond = vi.fn();
    await dispatchSession(test, handler, {
      respond,
      allowOwnSessionScope: true,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("projects the original own-session grant through a model call to the registered route", async () => {
    const test = fixture(["operator.sessions.write"], "alice");
    const handler = vi.fn<GatewayRequestHandler>(({ client, sessionAccessAuthority, respond }) => {
      sessionAccessAuthority!.assertCurrent();
      respond(true, { scopes: client!.connect.scopes });
    });
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers[method] = handler;
    registry.gatewayMethodDescriptors.push(descriptor(handler, true));
    setActivePluginRegistry(registry);
    test.context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(registry.gatewayMethodDescriptors, registry);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "alice",
      scopes: ["operator.sessions.write"],
      assertCurrent: () => test.grant.signal.throwIfAborted(),
    });
    mocks.ambient = {
      agentId: "main",
      sessionKey: key,
      operatorAuthority,
      operationalRunInstance: { runId: "run-one", instanceId: "instance-one" },
      assertToolAllowed: vi.fn(),
      gatewayContextResolver: () => test.context,
    };
    await withPluginRuntimeGatewayRequestScope(
      { client: test.client, context: test.context, isWebchatConnect: () => false },
      async () => {
        await expect(
          callInProcessGatewayTool(method, { sessionKey: key, agentId: "main" }),
        ).resolves.toEqual({ scopes: ["operator.sessions.write"] });
      },
    );
    expect(handler).toHaveBeenCalledOnce();
  });
  it.each([
    { scopes: ["operator.write"], creator: "someone-else", allowed: true },
    { scopes: ["operator.sessions.write"], creator: "former-alice", allowed: true },
    { scopes: ["operator.sessions.write"], creator: "someone-else", allowed: false },
    { scopes: ["operator.read"], creator: "alice", allowed: false },
  ])(
    "routes $scopes through canonical session admission for creator $creator",
    async ({ scopes, creator, allowed }) => {
      const test = fixture(scopes, creator);
      let admitted: Parameters<GatewayRequestHandler>[0]["sessionAccessAuthority"];
      let resource: ReturnType<NonNullable<typeof admitted>["retainSession"]> | undefined;
      const handler = vi.fn<GatewayRequestHandler>(({ sessionAccessAuthority, respond }) => {
        admitted = sessionAccessAuthority;
        resource = hold(admitted!.retainSession());
        respond(true, { ok: true });
      });
      const respond = vi.fn();
      await dispatchSession(test, handler, { respond, allowOwnSessionScope: true });
      expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(respond.mock.calls[0]?.[0]).toBe(allowed);
      if (allowed) {
        expect(() => admitted!.assertCurrent()).toThrow();
        expect(() => admitted!.retainSession()).toThrow();
        expect(() => resource!.assertCurrent()).not.toThrow();
      }
    },
  );

  it.each(["receipt", "profile selection"])(
    "fences %s expiry without attaching it to retained actor or session lifetime",
    async (kind) => {
      await withStoredSession(async (test, scope) => {
        const { projection } = test;
        let invocationActive = true;
        const assertActive = () => {
          if (!invocationActive) {
            throw new Error("receipt expired");
          }
        };
        let viewer: ReturnType<sessionAccess.GatewaySessionAccessAuthority["retain"]> | undefined;
        let resource: typeof viewer;
        let committed: ReturnType<typeof loadSessionEntryReadOnly>;
        const response = vi.fn();
        const handler: GatewayRequestHandler = async ({ sessionAccessAuthority, respond }) => {
          const authority = expectDefined(sessionAccessAuthority, "registered session authority");
          viewer = hold(authority.retain());
          resource = hold(authority.retainSession());
          const options = { assertCommitAllowed: authority.assertCurrent, skipMaintenance: true };
          await patchSessionEntryCore(
            scope,
            () => ({ label: "allowed invocation write" }),
            options,
          );
          committed = structuredClone(loadSessionEntryReadOnly(scope));
          await projection.prepareMembership();
          const entered = createDeferredCore();
          const resume = createDeferredCore();
          // The canonical writer owns this awaited updater and checks authority before SQL commit.
          const pending = patchSessionEntryCore(
            scope,
            async () => {
              entered.resolve();
              await resume.promise;
              return { label: "expired invocation write" };
            },
            options,
          );
          const settled = pending.catch((error: unknown) => error);
          try {
            await awaitGateBeforeSettlement(
              entered.promise,
              pending,
              "Session mutation settled before invocation expiry",
            );
            invocationActive = false;
            resume.resolve();
            expect(await settled).toMatchObject({ message: "receipt expired" });
            expect(() => authority.retain()).toThrow("receipt expired");
            expect(() => authority.retainSession()).toThrow("receipt expired");
            respond(true, {});
          } finally {
            resume.resolve();
            await settled;
          }
        };
        await dispatchSession(test, handler, {
          respond: response,
          sessionMutationCommitGuard: kind === "receipt" ? assertActive : undefined,
          ...(kind === "profile selection"
            ? {
                expectedProfileBinding: {
                  assertCurrent: assertActive,
                  assertMatchesResolvedProfile: () => {},
                  markInvoked: () => {},
                  guardResponse: (respond) => respond,
                },
              }
            : {}),
        });
        expect(response).toHaveBeenCalledExactlyOnceWith(true, {});
        expect(committed).toMatchObject({ label: "allowed invocation write" });
        expect(loadSessionEntryReadOnly(scope)).toEqual(committed);
        expectCurrent(viewer!, resource!);
      });
    },
  );

  it("preserves a resource through row progress but retires identical IDs in a replaced physical database", async () => {
    await withStoredSession(async (test, scope, state) => {
      const { storePath } = scope;
      const { projection } = test;
      const staged = state.statePath("imports", "replacement.sqlite");
      const entry = sessionEntry();
      replaceSessionEntrySync({ agentId: "main", storePath: staged, sessionKey: key }, entry);
      await closeOpenClawAgentDatabaseByPathAsync(staged, "main");
      const { authority, resource, viewer } = await borrowSession(test);
      authority.release();
      expect(() => authority.retainSession()).toThrow();
      expect(() => authority.assertCurrent()).toThrow();
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: key },
        { ...entry, updatedAt: 2, label: "Progress" },
      );
      await projection.ensureMaterialized();
      await projection.prepareMembership();
      expectCurrent(resource, viewer);
      // Config publication invalidates topology synchronously, before its existing
      // background drain can publish unchanged session facts.
      setRuntimeConfigSnapshot(test.context.getRuntimeConfig());
      expect(() => resource.assertCurrent()).toThrow("refreshing");
      expect(resource.signal.aborted).toBe(false);
      test.grant.abort(new Error("original grant revoked while session facts refresh"));
      expect(viewer.signal.aborted).toBe(true);
      expect(() => viewer.assertCurrent()).toThrow();
      expect(resource.signal.aborted).toBe(false);
      await projection.prepareMembership();
      expect(() => resource.assertCurrent()).not.toThrow();
      expect(resource.signal.aborted).toBe(false);
      renewGrant(test);
      expect(() => viewer.assertCurrent()).toThrow();
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
      renameSync(staged, storePath);
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      await projection.ensureMaterialized();
      await projection.prepareMembership();
      expect(() => resource.assertCurrent()).toThrow();
      expect(resource.signal.aborted).toBe(true);
    });
  });

  it("coalesces pending preparation, does not loop on failure, and stops after release", async () => {
    const { test, resource, readyState, state } = await retainedResource();
    const prepare = vi
      .spyOn(test.projection, "prepareMembership")
      .mockRejectedValue(new Error("worker unavailable"));
    sessionChanges.emit({ all: true, scope: "config" });
    sessionChanges.emit({ all: true, scope: "config" });
    await setImmediate();
    expect(prepare).toHaveBeenCalledOnce();
    expect(resource.signal.aborted).toBe(false);
    expect(() => resource.assertCurrent()).toThrow("refreshing");
    state.mockReturnValue(readyState);
    expect(() => resource.assertCurrent()).not.toThrow();
    resource.release();
    state.mockReturnValue({ status: "pending" });
    sessionChanges.emit({ all: true, scope: "config" });
    await setImmediate();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("rechecks a publication in the preparation settlement window before releasing a retired resource", async () => {
    const { test, resource, readyState, state } = await retainedResource();
    const first = createDeferredCore();
    const prepare = vi
      .spyOn(test.projection, "prepareMembership")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => {
        state.mockReturnValue({ status: "missing" });
      });
    sessionChanges.emit({ all: true, scope: "config" });
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledOnce();
    state.mockReturnValue(readyState);
    first.resolve();
    // Publish a second change after preparation resolves but before its awaiting
    // resource owner resumes. The successor has authoritative deletion facts.
    state.mockReturnValue({ status: "pending" });
    sessionChanges.emit({ all: true, scope: "stores" });
    await setImmediate();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(resource.signal.aborted).toBe(true);
  });
  it("retires both borrowers for a reset even before its replacement row is published", async () => {
    const { resource, viewer } = await borrowSession();
    emitSessionIdentityMutation({
      kind: "reset",
      agentId: "main",
      databaseIdentity: Symbol("session-access-fixture-database"),
      previous: { sessionId: "session-1", sessionKeys: [key] },
      current: { sessionId: "session-2", sessionKeys: [key] },
    });
    expect(resource.signal.aborted).toBe(true);
    expect(viewer.signal.aborted).toBe(true);
  });

  it.each<"sandboxRequired" | "sandboxed" | "toolAllowed" | "sharing">([
    "sandboxRequired",
    "sandboxed",
    "toolAllowed",
    "sharing",
  ])("retires a viewer when its %s policy changes, even if later restored", async (field) => {
    const test = fixture();
    const { viewer, resource } = await borrowSession(test);
    if (field === "sharing") {
      test.setVisibility("draft");
      sessionChanges.emit({ agentId: "main", sessionKey: key });
    } else {
      mocks[field] = field !== "toolAllowed";
    }
    expect(viewer.signal.aborted).toBe(field === "sharing");
    expect(() => viewer.assertCurrent()).toThrow(
      field === "sharing"
        ? "Session access changed"
        : field === "toolAllowed"
          ? "tool denied"
          : "current tool policy",
    );
    if (field === "sharing") {
      test.setVisibility("shared");
    } else {
      mocks[field] = field === "toolAllowed";
    }
    expect(() => viewer.assertCurrent()).toThrow();
    expect(() => resource.assertCurrent()).not.toThrow();
  });

  it("rejects a mismatched ambient model cap even when the explicit tool caller matches", async () => {
    const test = fixture();
    test.client.internal!.syntheticClient = true;
    test.client.internal!.agentToolCaller = {
      sessionKey: key,
      agentId: "main",
      assertCurrent: () => {},
    };
    mocks.ambient = { sessionKey: "agent:main:other", agentId: "main", assertToolAllowed: vi.fn() };
    await expect(test.prepare()).rejects.toThrow("Session access changed");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
