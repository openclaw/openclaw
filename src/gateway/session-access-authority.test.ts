import { renameSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestHandler } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import * as sessionAccess from "./session-access-authority.js";
import { prepareGatewaySessionAccessAuthority } from "./session-access-authority.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

const mocks = vi.hoisted(() => ({
  profileCurrent: true,
  prepare: vi.fn(),
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
const held: Array<{ release: () => void }> = [];
function hold<T extends { release: () => void }>(value: T): T {
  held.push(value);
  return value;
}

function fixture(scopes = ["operator.write"], creator = "someone-else") {
  const grant = new AbortController();
  let entry: SessionEntry | undefined = {
    sessionId: "session-1",
    lifecycleRevision: "incarnation-1",
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: creator },
    visibility: "shared",
  };
  let generation = Symbol("database");
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
    sharingTarget: () =>
      entry
        ? {
            agentId: "main",
            canonicalKey: key,
            entry,
            generation,
            storePath: "/test/sessions",
            storeKey: key,
            storeKeys: [key],
          }
        : null,
    hasMembership: () => false,
    sharingTargetState: () => {
      const target = projection.sharingTarget({ agentId: "main", key });
      return target ? { status: "ready", target } : { status: "missing" };
    },
  } as unknown as SessionRowProjection;
  return {
    grant,
    client,
    context,
    projection,
    setEntry(next: SessionEntry | undefined) {
      entry = next;
    },
    replaceGeneration() {
      generation = Symbol("replacement database");
    },
    prepare: async (ownSessionOnly = false) =>
      hold(
        await prepareGatewaySessionAccessAuthority({
          policy: { mode: "write", requiredTool: "browser", allowOwnSessionScope: true },
          requestParams: { sessionKey: key, agentId: "main" },
          context,
          client,
          ownSessionOnly,
        }),
      ),
  };
}

beforeEach(() => {
  mocks.profileCurrent = true;
  mocks.toolAllowed = true;
  mocks.sandboxRequired = false;
  mocks.sandboxed = false;
  mocks.ambient = undefined;
  mocks.assertAmbient.mockReset();
  mocks.prepare.mockReset().mockImplementation(async () => ({
    profileId: "alice",
    role: null,
    aliases: ["alice", "former-alice"],
    isCurrent: () => mocks.profileCurrent,
  }));
});
afterEach(() => {
  for (const authority of held.splice(0)) {
    authority.release();
  }
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("session resource admission", () => {
  it.each(["identity", "scope"])(
    "hydrates the profile before capture and fences a later operator %s change",
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
      const method = "fixture.session.open";
      await handleGatewayRequest({
        req: { type: "req", id: "hydration", method, params: { sessionKey: key } },
        respond: vi.fn(),
        client: test.client,
        context: test.context,
        methodRegistry: createGatewayMethodRegistry([
          createPluginGatewayMethodDescriptor({
            pluginId: "fixture",
            name: method,
            handler,
            scope: "operator.write",
            sessionAccess: { mode: "write", requiredTool: "browser" },
          }),
        ]),
        isWebchatConnect: () => false,
      });
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
        const authority = await prepare(params);
        release.mockImplementation(authority.release);
        return {
          ...authority,
          assertCurrent: () => {
            authority.assertCurrent();
            test.client.connect.scopes = scopes;
          },
          release,
        };
      });
    const handler = vi.fn<GatewayRequestHandler>();
    const method = "fixture.session.open";
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "final-denial", method, params: { sessionKey: key } },
      respond,
      client: test.client,
      context: test.context,
      methodRegistry: createGatewayMethodRegistry([
        createPluginGatewayMethodDescriptor({
          pluginId: "fixture",
          name: method,
          handler,
          scope: "operator.write",
          sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "browser" },
        }),
      ]),
      isWebchatConnect: () => false,
    });
    expect(capture).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("projects the original own-session grant through a model call to the registered route", async () => {
    const test = fixture(["operator.sessions.write"], "alice");
    const method = "fixture.session.open";
    const handler = vi.fn<GatewayRequestHandler>(({ client, sessionAccessAuthority, respond }) => {
      sessionAccessAuthority!.assertCurrent();
      respond(true, { scopes: client!.connect.scopes });
    });
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers[method] = handler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "fixture",
        name: method,
        handler,
        scope: "operator.write",
        sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "browser" },
      }),
    );
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
    { scopes: ["operator.sessions.write"], creator: "alice", allowed: true },
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
      const method = "fixture.session.open";
      const methodRegistry = createGatewayMethodRegistry([
        createPluginGatewayMethodDescriptor({
          pluginId: "fixture",
          name: method,
          handler,
          scope: "operator.write",
          sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "browser" },
        }),
      ]);
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "one", method, params: { sessionKey: key, agentId: "main" } },
        respond,
        client: test.client,
        context: test.context,
        methodRegistry,
        isWebchatConnect: () => false,
      });
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
      const test = fixture();
      let invocationActive = true;
      let viewer: ReturnType<Awaited<ReturnType<typeof test.prepare>>["retain"]> | undefined;
      let resource: typeof viewer;
      const method = "fixture.session.open";
      const handler: GatewayRequestHandler = async ({ sessionAccessAuthority, respond }) => {
        const authority = sessionAccessAuthority!;
        viewer = hold(authority.retain());
        resource = hold(authority.retainSession());
        await Promise.resolve();
        invocationActive = false;
        expect(() => authority.assertCurrent()).toThrow("receipt expired");
        expect(() => authority.retain()).toThrow("receipt expired");
        expect(() => authority.retainSession()).toThrow("receipt expired");
        expect(() => viewer!.assertCurrent()).not.toThrow();
        expect(() => resource!.assertCurrent()).not.toThrow();
        respond(true, {});
      };
      const methodRegistry = createGatewayMethodRegistry([
        createPluginGatewayMethodDescriptor({
          pluginId: "fixture",
          name: method,
          handler,
          scope: "operator.write",
          sessionAccess: { mode: "write", requiredTool: "browser" },
        }),
      ]);
      await handleGatewayRequest({
        req: { type: "req", id: "one", method, params: { sessionKey: key } },
        respond: vi.fn(),
        client: test.client,
        context: test.context,
        methodRegistry,
        isWebchatConnect: () => false,
        sessionMutationCommitGuard: () => {
          if (kind === "receipt" && !invocationActive) {
            throw new Error("receipt expired");
          }
        },
        ...(kind === "profile selection"
          ? {
              expectedProfileBinding: {
                assertCurrent: () => {
                  if (!invocationActive) {
                    throw new Error("receipt expired");
                  }
                },
                assertMatchesResolvedProfile: () => {},
                markInvoked: () => {},
                guardResponse: (respond) => respond,
              },
            }
          : {}),
      });
      expect(() => viewer!.assertCurrent()).not.toThrow();
      expect(() => resource!.assertCurrent()).not.toThrow();
    },
  );

  it("preserves a resource through row progress but retires identical IDs in a replaced physical database", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const staged = state.statePath("imports", "replacement.sqlite");
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storePath },
      };
      const entry: SessionEntry = {
        sessionId: "same-session",
        lifecycleRevision: "same-incarnation",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "alice" },
      };
      replaceSessionEntrySync({ agentId: "main", storePath, sessionKey: key }, entry);
      replaceSessionEntrySync({ agentId: "main", storePath: staged, sessionKey: key }, entry);
      await closeOpenClawAgentDatabaseByPathAsync(staged, "main");
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const test = fixture();
      const context = bindSessionRowProjection(
        { ...test.context, getRuntimeConfig: () => cfg },
        () => projection,
      );
      try {
        await projection.ensureMaterialized();
        const authority = hold(
          await prepareGatewaySessionAccessAuthority({
            context,
            client: test.client,
            requestParams: { sessionKey: key },
            policy: { mode: "write", requiredTool: "browser" },
            ownSessionOnly: false,
          }),
        );
        const resource = hold(authority.retainSession());
        const viewer = hold(authority.retain());
        authority.release();
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: key },
          { ...entry, updatedAt: 2, label: "Progress" },
        );
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(() => resource.assertCurrent()).not.toThrow();
        expect(() => viewer.assertCurrent()).not.toThrow();
        // Config publication invalidates topology synchronously, before its existing
        // background drain can publish unchanged session facts.
        setRuntimeConfigSnapshot(cfg);
        expect(() => resource.assertCurrent()).toThrow("refreshing");
        expect(resource.signal.aborted).toBe(false);
        test.grant.abort(new Error("original grant revoked while session facts refresh"));
        expect(viewer.signal.aborted).toBe(true);
        expect(resource.signal.aborted).toBe(false);
        await projection.prepareMembership();
        expect(() => resource.assertCurrent()).not.toThrow();
        expect(resource.signal.aborted).toBe(false);
        await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
        renameSync(staged, storePath);
        registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(() => resource.assertCurrent()).toThrow();
      } finally {
        projection.dispose();
      }
    });
  });

  it("coalesces pending preparation, does not loop on failure, and stops after release", async () => {
    const test = fixture();
    const authority = await test.prepare();
    const resource = hold(authority.retainSession());
    authority.release();
    const readyState = test.projection.sharingTargetState({ agentId: "main", key });
    const state = vi
      .spyOn(test.projection, "sharingTargetState")
      .mockReturnValue({ status: "pending" });
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
    const test = fixture();
    const authority = await test.prepare();
    const resource = hold(authority.retainSession());
    authority.release();
    const readyState = test.projection.sharingTargetState({ agentId: "main", key });
    const state = vi
      .spyOn(test.projection, "sharingTargetState")
      .mockReturnValue({ status: "pending" });
    let finish!: () => void;
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prepare = vi
      .spyOn(test.projection, "prepareMembership")
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => {
        state.mockReturnValue({ status: "missing" });
      });
    sessionChanges.emit({ all: true, scope: "config" });
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledOnce();
    state.mockReturnValue(readyState);
    finish();
    // Publish a second change after preparation resolves but before its awaiting
    // resource owner resumes. The successor has authoritative deletion facts.
    state.mockReturnValue({ status: "pending" });
    sessionChanges.emit({ all: true, scope: "stores" });
    await setImmediate();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(resource.signal.aborted).toBe(true);
  });
  it("preserves broad shared-session writes while restricting the narrow scope to its creator", async () => {
    await expect(fixture().prepare()).resolves.toBeDefined();
    await expect(fixture(["operator.sessions.write"]).prepare(true)).rejects.toThrow(
      "Session access changed",
    );
    await expect(
      fixture(["operator.sessions.write"], "former-alice").prepare(true),
    ).resolves.toBeDefined();
  });

  it("keeps a session resource after request completion and actor revocation, without reviving that actor", async () => {
    const test = fixture();
    const authority = await test.prepare();
    const viewer = hold(authority.retain());
    const resource = hold(authority.retainSession());
    authority.release();
    expect(() => authority.retainSession()).toThrow();
    expect(() => authority.assertCurrent()).toThrow();
    expect(() => resource.assertCurrent()).not.toThrow();
    test.grant.abort(new Error("original invitation expired"));
    expect(viewer.signal.aborted).toBe(true);
    expect(() => viewer.assertCurrent()).toThrow();
    expect(() => resource.assertCurrent()).not.toThrow();
    test.client.internal!.operatorAccessAuthority = {
      signal: new AbortController().signal,
      assertCurrent: () => {},
    } as never;
    expect(() => viewer.assertCurrent()).toThrow();
  });

  it("retires both borrowers for a reset even before its replacement row is published", async () => {
    const authority = await fixture().prepare();
    const resource = hold(authority.retainSession());
    const viewer = hold(authority.retain());
    emitSessionIdentityMutation({
      kind: "reset",
      agentId: "main",
      previous: { sessionId: "session-1", sessionKeys: [key] },
      current: { sessionId: "session-2", sessionKeys: [key] },
    });
    expect(resource.signal.aborted).toBe(true);
    expect(viewer.signal.aborted).toBe(true);
  });

  it("retires same-ID resources after a resident physical-store generation replacement", async () => {
    const test = fixture();
    const authority = await test.prepare();
    const resource = hold(authority.retainSession());
    test.replaceGeneration();
    sessionChanges.emit({ agentId: "main", sessionKey: key });
    expect(resource.signal.aborted).toBe(true);
    expect(() => authority.assertCurrent()).toThrow();
  });

  it.each(["sandboxRequired", "sandboxed"] as const)(
    "retires the original actor when its %s policy changes, even if later restored",
    async (field) => {
      const test = fixture();
      const authority = await test.prepare();
      const viewer = hold(authority.retain());
      const resource = hold(authority.retainSession());
      mocks[field] = true;
      expect(() => viewer.assertCurrent()).toThrow("current tool policy");
      mocks[field] = false;
      expect(() => viewer.assertCurrent()).toThrow();
      expect(() => resource.assertCurrent()).not.toThrow();
    },
  );

  it("rechecks sharing and effective tool policy on retained viewer use", async () => {
    const test = fixture();
    const authority = await test.prepare();
    const viewer = hold(authority.retain());
    mocks.toolAllowed = false;
    expect(() => viewer.assertCurrent()).toThrow("tool denied");
    mocks.toolAllowed = true;
    expect(() => viewer.assertCurrent()).toThrow();
    const other = fixture();
    const otherAuthority = await other.prepare();
    const otherViewer = hold(otherAuthority.retain());
    other.setEntry({
      sessionId: "session-1",
      lifecycleRevision: "incarnation-1",
      updatedAt: 2,
      createdActor: { type: "human", source: "profile", id: "someone-else" },
      visibility: "draft",
    });
    sessionChanges.emit({ agentId: "main", sessionKey: key });
    expect(otherViewer.signal.aborted).toBe(true);
  });

  it("rejects a renewed ingress grant that changes while profile preparation awaits", async () => {
    const test = fixture();
    let finish!: (profile: unknown) => void;
    mocks.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = test.prepare();
    test.client.internal!.operatorAccessAuthority = {
      signal: new AbortController().signal,
      assertCurrent: () => {},
    } as never;
    finish({ profileId: "alice", role: null, aliases: ["alice"], isCurrent: () => true });
    await expect(pending).rejects.toThrow("Session access changed");
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
