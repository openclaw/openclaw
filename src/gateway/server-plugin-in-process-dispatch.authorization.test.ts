import { beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  assertAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "../agents/admitted-run-context.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import {
  getOwnedSessionTranscriptActor,
  withOwnedSessionTranscriptWrites,
} from "../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveNodeInvokeRuntimeAuthorityError } from "./server-methods/nodes.invoke-authority.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess as dispatchMethod,
  runWithOperatorToolGatewayCleanupContext as withCleanup,
  withOperatorToolGatewayAuthority as withToolAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { registerInProcessGatewayDispatchPreparationTests } from "./server-plugin-in-process-dispatch.preparation.test-support.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());

vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn }),
}));

function writer(profileName = "writer", scopes = ["operator.write"], caps?: string[]) {
  return createOperatorClient({ profileName, scopes, caps });
}

function scoped<T>(
  scope: Omit<Parameters<typeof withPluginRuntimeGatewayRequestScope>[0], "isWebchatConnect">,
  run: () => T,
) {
  return withPluginRuntimeGatewayRequestScope({ ...scope, isWebchatConnect: () => false }, run);
}

function agentParams(idempotencyKey: string, extra: Record<string, unknown> = {}) {
  return { message: "authorization probe", idempotencyKey, ...extra };
}

function dispatchScopedMethod(
  method: "agent" | "agent.wait",
  params: Record<string, unknown>,
  {
    client = writer(),
    context = createContext(),
    signal,
  }: {
    client?: NonNullable<GatewayRequestOptions["client"]>;
    context?: GatewayRequestContext;
    signal?: AbortSignal;
  } = {},
) {
  return scoped({ client, context }, () =>
    dispatchMethod(method, params, {
      disableSyntheticClient: true,
      requireScopedClient: true,
      ...(signal ? { signal } : {}),
    }),
  );
}

const limitedRole: GatewayOperatorRoleDefinition = {
  agents: ["guest"],
  scopes: ["operator.write"],
  sessions: { others: "none" },
};
const foreignSessionKey = "agent:maintainer:main";

function configureRoles(
  context: GatewayRequestContext,
  definitions: Record<string, GatewayOperatorRoleDefinition> = { limited: limitedRole },
) {
  context.getRuntimeConfig = () => ({ gateway: { roles: { default: "limited", definitions } } });
  setRuntimeConfigSnapshot(context.getRuntimeConfig());
}

function seedSession(key: string, entry: Partial<SessionEntry> = {}, ownerId = "maintainer") {
  return upsertSessionEntryCore(
    { agentId: key.split(":")[1]!, sessionKey: key },
    {
      sessionId: "foreign-session",
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: ownerId },
      ...entry,
    },
  );
}

function sessionContext(
  method: string,
  handler: (options: GatewayRequestHandlerOptions) => void | Promise<void>,
  scope: "operator.read" | "operator.write" = "operator.write",
) {
  return createContext([[method, scope, "sessions", handler]]);
}

function syntheticOptions(
  context: GatewayRequestContext,
  options: NonNullable<Parameters<typeof dispatchMethod>[2]> = {},
) {
  return { forceSyntheticClient: true, resolveGatewayContext: () => context, ...options };
}

function duplexStream(onDispatchReady = vi.fn()) {
  return { onProgress: vi.fn(), onDispatchReady, isRuntimeCurrent: () => true };
}

beforeEach(() => {
  startTurn.mockReset();
  waitForTurn.mockReset();
});

it("releases session fact observers after a typed child launch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:subagent:heap-child";
    const context = createContext();
    setRuntimeConfigSnapshot(context.getRuntimeConfig());
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "heap-child-session", updatedAt: 1 },
    );
    const listeners = readGlobalSingleton(Symbol.for("openclaw.sessionIdentityMutationListeners"));
    if (!(listeners instanceof Set)) {
      throw new Error("Session identity observer owner is unavailable");
    }
    const original = new Set(listeners);
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "heap-child-run", status: "accepted" }, undefined]);
    });

    await expect(
      dispatchMethod(
        "agent",
        { sessionKey, message: "synthetic child", idempotencyKey: "heap-child-run" },
        syntheticOptions(context, { operatorRoleActor: { kind: "system" } }),
      ),
    ).resolves.toEqual({ runId: "heap-child-run", status: "accepted" });
    expect(listeners).toEqual(original);
  });
});

it.each([false, true])(
  "launches a different session without the caller's transcript writer (tool authority: %s)",
  async (toolAuthority) => {
    const database = { agentId: "main", path: "/synthetic/launch-transcript" };
    const owner = createMemorySessionActorOwner(database);
    const callerTarget = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:dashboard:incognito-caller",
      sessionId: "caller-session",
    };
    const launchedTarget = {
      ...callerTarget,
      sessionKey: "agent:main:launched",
      sessionId: "launched-session",
    };
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey: callerTarget.sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const sessionActor = { actor, database };
    const context = createContext();
    const result = { runId: "launched-run", status: "accepted" };
    startTurn.mockImplementation(async ({ io }) => {
      await Promise.resolve();
      expect(getOwnedSessionTranscriptActor(launchedTarget)).toBeUndefined();
      io.emitAcceptance([true, result, undefined]);
    });
    const launch = () =>
      dispatchMethod(
        "agent",
        {
          message: "Run in another session",
          idempotencyKey: result.runId,
          sessionKey: launchedTarget.sessionKey,
        },
        syntheticOptions(context),
      );
    try {
      await withOwnedSessionTranscriptWrites(
        { sessionTarget: callerTarget, sessionActor, withTranscriptWrite: async (run) => run() },
        async () => {
          expect(getOwnedSessionTranscriptActor(callerTarget)).toBe(sessionActor);
          expect(() => getOwnedSessionTranscriptActor(launchedTarget)).toThrow(
            "session writer claim changed before transcript persistence",
          );
          await expect(
            toolAuthority
              ? withToolAuthority(
                  { operatorRoleActor: { kind: "system" }, scopes: ["operator.write"] },
                  launch,
                )
              : launch(),
          ).resolves.toEqual(result);
          expect(getOwnedSessionTranscriptActor(callerTarget)).toBe(sessionActor);
        },
      );
    } finally {
      await actor.release();
      owner.close();
    }
  },
);

it.each([
  ["agent", { message: "owned turn", idempotencyKey: "host-owned" }],
  ["agent.wait", { runId: "host-owned" }],
] as const)(
  "uses the captured host factory for %s and refuses an ownerless context",
  async (method, params) => {
    const client = writer("owner", ["operator.write"], [GATEWAY_CLIENT_CAPS.TOOL_EVENTS]);
    const context = createContext();
    context.registerToolEventRecipient = vi.fn();
    const createFacade = vi.fn(context.createAgentTurnFacade!);
    context.createAgentTurnFacade = createFacade;
    const result = { runId: "host-owned", status: "ok" };
    startTurn.mockImplementation(async ({ io, onRunObserved }) => {
      onRunObserved?.("host-owned");
      io.emitAcceptance([true, result, undefined]);
    });
    waitForTurn.mockResolvedValue({ result });

    await expect(dispatchScopedMethod(method, params, { client, context })).resolves.toEqual(
      result,
    );
    expect(createFacade).toHaveBeenCalledOnce();
    if (method === "agent") {
      expect(context.registerToolEventRecipient).toHaveBeenCalledWith("host-owned", client.connId);
    }
    const capturedClient = createFacade.mock.calls[0]?.[0].client;
    expect(capturedClient).toMatchObject(client);
    const authority = capturedClient?.internal?.operatorRunAuthority;
    assertAdmittedRunOperatorAuthority(authority);
    expect(authority).toMatchObject({
      profileId: client.authenticatedUserProfile!.profileId,
      scopes: ["operator.write"],
    });
    expect(client.internal?.operatorRunAuthority).toBeUndefined();

    delete context.createAgentTurnFacade;
    await expect(dispatchScopedMethod(method, params, { client, context })).rejects.toThrow(
      "Gateway instance agent turn facade unavailable",
    );
  },
);

registerInProcessGatewayDispatchPreparationTests({ startTurn, waitForTurn });

it.each([
  { method: "sessions.patch", cleanup: false, scopedActor: false },
  { method: "agent", cleanup: false, scopedActor: false },
  { method: "sessions.patch", cleanup: true, scopedActor: false },
  { method: "sessions.patch", cleanup: false, scopedActor: true },
  { method: "sessions.patch", cleanup: true, scopedActor: true },
])(
  "keeps operator restrictions for $method (cleanup: $cleanup, scoped: $scopedActor)",
  async ({ method, cleanup, scopedActor }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const ownerProfile = ensureProfileForEmail("cleanup-owner@example.test");
      setUserProfileRole(ownerProfile.id, scopedActor ? "writer" : "limited");
      const owner = createOperatorClient({
        profileId: ownerProfile.id,
        scopes: ["operator.write"],
      });
      const patchHandler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
        respond(true, { ok: true }),
      );
      const context = sessionContext("sessions.patch", patchHandler);
      configureRoles(context, {
        writer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
        limited: limitedRole,
      });
      await seedSession(foreignSessionKey);
      startTurn.mockImplementation(async ({ io }) =>
        io.emitAcceptance([true, { runId: "forbidden-run", status: "accepted" }, undefined]),
      );

      const authority = {
        authenticatedUserProfile: owner.authenticatedUserProfile!,
        scopes: owner.connect.scopes ?? [],
      };
      const limitedProfile = ensureProfileForEmail("limited-cleanup-actor@example.test");
      setUserProfileRole(limitedProfile.id, "limited");
      const withAuthority = <T>(run: () => Promise<T>) =>
        scoped(
          {
            context,
            ...(scopedActor
              ? {
                  client: {
                    ...owner,
                    internal: {
                      operatorRoleActor: { kind: "operator", profileId: limitedProfile.id },
                    },
                  },
                }
              : {}),
          },
          () => withToolAuthority(authority, run),
        );
      const dispatch = () =>
        dispatchMethod(
          method,
          method === "sessions.patch"
            ? { key: foreignSessionKey, pinned: true }
            : agentParams("forbidden-run", { sessionKey: foreignSessionKey }),
          syntheticOptions(context, {
            operatorRoleActor: { kind: "system" },
            syntheticScopes: ["operator.write"],
          }),
        );
      if (scopedActor) {
        await expect(withToolAuthority(authority, dispatch)).resolves.toEqual({
          ok: true,
        });
        patchHandler.mockClear();
      }
      let pending: Promise<unknown>;
      if (cleanup) {
        const released = createDeferredCore();
        const handoff = await withAuthority(async () => ({
          pending: withCleanup(() => released.promise.then(dispatch)),
        }));
        released.resolve();
        pending = handoff.pending;
      } else {
        pending = withAuthority(dispatch);
      }
      await expect(pending).rejects.toThrow(/not found|cannot create sessions/i);
      expect(patchHandler).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
    });
  },
);

it.each(["explicit", "scoped"])(
  "does not fall back to ambient scope when a %s Gateway binding is retired",
  async (binding) => {
    const ambient = sessionContext(
      "sessions.list",
      ({ respond }) => {
        respond(true, { sessions: [] });
      },
      "operator.read",
    );

    await scoped(
      {
        context: ambient,
        ...(binding === "scoped" ? { resolveGatewayContext: () => undefined } : {}),
      },
      () =>
        expect(
          dispatchMethod(
            "sessions.list",
            {},
            {
              forceSyntheticClient: true,
              ...(binding === "explicit" ? { resolveGatewayContext: () => undefined } : {}),
              syntheticScopes: ["operator.read"],
            },
          ),
        ).rejects.toThrow("instance binding"),
    );
  },
);

it.each(["gateway", "explicit", "system-tool"] as const)(
  "rejects a session commit after its %s authority closes",
  async (source) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let current = true;
    let committed = false;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("caller authority closed");
      }
    };
    const context = sessionContext(
      "sessions.create",
      async ({ respond, sessionMutationCommitGuard }) => {
        entered.resolve();
        await release.promise;
        sessionMutationCommitGuard?.();
        committed = true;
        respond(true, { key: "agent:main:dashboard:child" });
      },
    );
    const replacement = createContext();
    const dispatch = () =>
      dispatchMethod(
        "sessions.create",
        { agentId: "main" },
        {
          forceSyntheticClient: true,
          syntheticScopes: ["operator.write"],
          ...(source === "gateway" ? {} : { resolveGatewayContext: () => context }),
          sessionMutationCommitGuard: source === "explicit" ? assertCurrent : undefined,
        },
      );
    const pending =
      source === "gateway"
        ? scoped(
            { context, resolveGatewayContext: () => (current ? context : replacement) },
            dispatch,
          )
        : source === "explicit"
          ? dispatch()
          : withToolAuthority(
              {
                operatorRoleActor: { kind: "system" },
                scopes: ["operator.write"],
                assertCurrent,
              },
              dispatch,
            );
    const rejected = expect(pending).rejects.toThrow(
      source === "gateway" ? "current gateway instance binding" : "caller authority closed",
    );
    await entered.promise;
    current = false;
    release.resolve();
    await rejected;
    expect(committed).toBe(false);
  },
);

it.each([
  { actor: "operator", scope: "operator.write", ambient: false, profileless: false },
  { actor: "system", scope: "operator.write", ambient: false, profileless: false },
  { actor: "system", scope: "operator.write", ambient: false, profileless: true },
  { actor: "system", scope: "operator.write", ambient: true, profileless: false },
  { actor: "system", scope: "operator.sessions.write", ambient: true, profileless: false },
] as const)(
  "keeps a $actor native launch host-owned (scope=$scope, ambient=$ambient, profileless=$profileless)",
  async ({ actor, scope, ambient, profileless }) => {
    const owner = writer("spawn-owner", ambient ? ["operator.admin"] : ["operator.write"]);
    if (ambient) {
      owner.internal = { operatorRoleActor: { kind: "system" } };
    }
    const operatorRoleActor = actor === "system" ? { kind: "system" as const } : undefined;
    const expectedActor = operatorRoleActor ?? {
      kind: "operator",
      profileId: owner.authenticatedUserProfile!.profileId,
    };
    let autonomousClient: GatewayRequestOptions["client"] = null;
    const context = sessionContext(
      "sessions.list",
      ({ client, respond }) => {
        autonomousClient = client;
        respond(true, { sessions: [] });
      },
      "operator.read",
    );
    const result = { runId: "autonomous-run", status: "accepted" };
    startTurn.mockImplementation(async ({ principal, io }) => {
      expect(principal.authenticatedUserProfile).toBeUndefined();
      expect(principal.internal).toMatchObject({ operatorRoleActor: expectedActor });
      if (ambient) {
        expect(principal.internal.operatorRoleActor).toEqual({ kind: "system" });
        expect(principal.connect.scopes).toEqual(["operator.write"]);
      } else if (!profileless) {
        await dispatchMethod(
          "sessions.list",
          {},
          syntheticOptions(context, { syntheticScopes: ["operator.read"] }),
        );
      }
      io.emitAcceptance([true, result, undefined]);
    });
    const launch = () =>
      ambient
        ? callAgentToolGatewayRequest({
            method: "agent",
            agentRunTracking: "native_subagent",
            params: agentParams(result.runId),
          })
        : dispatchMethod(
            "agent",
            agentParams(result.runId),
            syntheticOptions(context, {
              agentRunTracking: "native_subagent",
              syntheticScopes: ["operator.write"],
            }),
          );
    const invoke = () =>
      profileless
        ? launch()
        : withToolAuthority(
            {
              authenticatedUserProfile: owner.authenticatedUserProfile!,
              operatorRoleActor,
              scopes: [scope],
            },
            launch,
          );
    const request = ambient ? scoped({ client: owner, context }, invoke) : invoke();
    if (scope === "operator.sessions.write") {
      await expect(request).rejects.toThrow("missing scope: operator.write");
      expect(startTurn).not.toHaveBeenCalled();
    } else {
      await expect(request).resolves.toEqual(result);
      expect(startTurn).toHaveBeenCalledOnce();
      if (!ambient && !profileless) {
        expect(autonomousClient).toMatchObject({
          connect: { scopes: ["operator.read"] },
          internal: { operatorRoleActor: expectedActor },
        });
        expect(autonomousClient).not.toHaveProperty("authenticatedUserProfile");
      }
    }
  },
);

it("rejects tracked agent launches when a scoped operator identity was dropped", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const unidentifiedClient = createOperatorClient({
      profileId: "dropped-spawn-owner",
      scopes: ["operator.write"],
    });
    delete unidentifiedClient.authenticatedUserProfile;
    const context = createContext();
    configureRoles(context);
    await seedSession(foreignSessionKey, {
      sessionId: "maintainer-session",
      createdVia: "operator",
    });

    await expect(
      scoped({ client: unidentifiedClient, context }, () =>
        dispatchMethod(
          "agent",
          agentParams("dropped-spawn-owner", { sessionKey: foreignSessionKey }),
          {
            forceSyntheticClient: true,
            agentRunTracking: "native_subagent",
            operatorRoleActor: { kind: "system" },
            syntheticScopes: ["operator.write"],
          },
        ),
      ),
    ).rejects.toThrow(/scope|role|operator/i);
    expect(startTurn).not.toHaveBeenCalled();
  });
});

it.each([
  ["non-synthetic client", "node.invoke", { pluginRuntimeOwnerId: "duplex-fixture" }],
  ["ownerless synthetic client", "node.invoke", { forceSyntheticClient: true }],
  [
    "different gateway method",
    "node.list",
    { forceSyntheticClient: true, pluginRuntimeOwnerId: "duplex-fixture" },
  ],
] as const)("rejects node duplex hooks on a %s", async (_name, method, options) => {
  const onDispatchReady = vi.fn();

  await expect(
    dispatchMethod(
      method,
      {},
      {
        ...options,
        nodeInvokeStream: duplexStream(onDispatchReady),
        resolveGatewayContext: createContext,
      },
    ),
  ).rejects.toThrow("owner-bound trusted synthetic client");

  expect(onDispatchReady).not.toHaveBeenCalled();
});

it("retains the authenticated caller and its closure-bound authority for node duplex", async () => {
  const client = writer("duplex-owner", ["operator.write", "operator.approvals"]);
  const operationalRunInstance = createOperationalRunInstanceRef("duplex-owned-run");
  const agentRuntimeIdentity = {
    kind: "agentRuntime" as const,
    agentId: "main",
    sessionKey: "agent:main:duplex-owner",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local" as const,
      operationalRunInstance,
      lifecycleGeneration: "duplex-generation",
      claimId: "duplex-claim",
    },
  };
  client.isDeviceTokenAuth = true;
  client.internal = {
    agentRuntimeIdentity,
    approvalRuntime: true,
    senderAttribution: { id: "duplex-sender" },
  };
  let authorityCurrent = true;
  const dispatched: { client: GatewayRequestOptions["client"] } = { client: null };
  const context = createContext([
    [
      "node.invoke",
      "operator.write",
      "nodes",
      ({ client: resolvedClient, respond }) => {
        dispatched.client = resolvedClient;
        respond(true, { ok: true });
      },
    ],
  ]);
  context.validateAgentRuntimeApprovalAuthority = (identity) =>
    authorityCurrent && identity === agentRuntimeIdentity;

  await scoped({ client, context }, () =>
    dispatchMethod(
      "node.invoke",
      {},
      {
        forceSyntheticClient: true,
        pluginRuntimeOwnerId: "duplex-fixture",
        syntheticScopes: ["operator.write", "operator.approvals"],
        nodeInvokeStream: duplexStream(),
      },
    ),
  );

  expect(dispatched.client).toMatchObject({
    connId: client.connId,
    authenticatedUserId: client.authenticatedUserId,
    authenticatedUserProfile: client.authenticatedUserProfile,
    isDeviceTokenAuth: true,
    connect: { scopes: ["operator.write", "operator.approvals"] },
    internal: {
      syntheticClient: true,
      pluginRuntimeOwnerId: "duplex-fixture",
      approvalRuntime: true,
      senderAttribution: { id: "duplex-sender" },
    },
  });
  expect(dispatched.client?.internal?.agentRuntimeIdentity).toBe(agentRuntimeIdentity);
  expect(
    resolveNodeInvokeRuntimeAuthorityError({ context, client: dispatched.client }),
  ).toBeUndefined();

  authorityCurrent = false;
  expect(resolveNodeInvokeRuntimeAuthorityError({ context, client: dispatched.client })).toBe(
    "agent runtime approval authority closed before node dispatch",
  );
});

it("applies the pending-profile gate to typed in-process agent dispatch", async () => {
  const client = writer("pending");
  delete client.authenticatedUserProfile;
  client.authenticatedGitHubIdentitySync = vi
    .fn()
    .mockRejectedValue(new Error("private provider detail"));

  await expect(
    dispatchScopedMethod("agent", agentParams("authorization-probe"), { client }),
  ).rejects.toThrow("Authenticated profile verification is unavailable");
  expect(startTurn).not.toHaveBeenCalled();
});

it("rejects a nonparticipant agent turn before preflight", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const sessionKey = "agent:main:private-draft";
    await seedSession(
      sessionKey,
      { sessionId: "private-draft-session", visibility: "draft", createdVia: "operator" },
      "owner",
    );

    await expect(
      dispatchScopedMethod("agent", agentParams("authorization-probe", { sessionKey }), {
        client: writer("outsider"),
      }),
    ).rejects.toThrow("session is draft for this connection");
    expect(startTurn).not.toHaveBeenCalled();
  });
});

it.each([
  ["agent", agentParams("validation-probe", { sessionKey: 42 }), false],
  ["agent.wait", { runId: 42 }, false],
  ["agent", agentParams("cancelled-agent"), true],
  ["agent.wait", { runId: "cancelled-run" }, true],
] as const)("rejects %s %j before work (aborted=%s)", async (method, params, aborted) => {
  const controller = new AbortController();
  if (aborted) {
    controller.abort(new Error("already aborted"));
  }

  await expect(
    dispatchScopedMethod(method, params, { signal: aborted ? controller.signal : undefined }),
  ).rejects.toThrow(aborted ? "already aborted" : `invalid ${method} params:`);
  expect(startTurn).not.toHaveBeenCalled();
  expect(waitForTurn).not.toHaveBeenCalled();
});
