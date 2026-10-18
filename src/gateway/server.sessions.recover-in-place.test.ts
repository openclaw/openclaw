import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionsRecoverResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import * as sessionLifecycle from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { dispatchInboundMessageMock, writeSessionStore } from "./test-helpers.js";
import { getTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { resolveWorkerPlacementSessionRuntimeAsync } from "./worker-environments/placement-session-runtime.js";

// Keep the production RPC, authorization, recovery and input-storage owners.
// Only the downstream inference boundary is held while inspecting admission.
afterEach(() => drainGlobalSingletonLifecycleState());
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const prepareProfiles = useUserProfileCatalogForTest();
beforeEach(async () => {
  await prepareProfiles();
  dispatchInboundMessageMock.mockReset().mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
});
let requestSequence = 0;

async function fixture(
  name: string,
  runtime?: "codex" | "claude-cli",
  restricted = runtime === "claude-cli",
  deliveryConstraint?: "media" | "message" | "text",
) {
  const { storePath } = await createSessionStoreDir();
  const key = `agent:main:dashboard:${name}`;
  const sessionId = `${name}-session`;
  const recoveryCycleId = `cycle-${name}`;
  const owner = roleClient("view", `${name}-owner`);
  const operator = roleClient("write", `${name}-operator`);
  const retainedMetadata = {
    displayName: "Interrupted implementation",
    pinnedAt: 123,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: owner.authenticatedUserProfile!.profileId,
    },
    ...(runtime
      ? {
          ...(runtime === "codex" ? { agentHarnessId: runtime } : {}),
          agentRuntimeOverride: runtime,
          providerOverride: runtime === "codex" ? "openai" : "anthropic",
          modelOverride: runtime === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4-6",
          modelSelectionLocked: true,
        }
      : {}),
  };
  await writeSessionStore({
    entries: {
      [key]: sessionStoreEntry(sessionId, {
        ...retainedMetadata,
        status: "failed",
        abortedLastRun: false,
        ...(restricted
          ? {
              permissionMode: deliveryConstraint ? "full" : "guarded",
              restartRecoveryForceSafeTools: true,
            }
          : {}),
        ...(deliveryConstraint === "media" ? { restartRecoveryDeliveryMediaUrls: [] } : {}),
        ...(deliveryConstraint === "message" ? { restartRecoveryDisableMessageTool: true } : {}),
        ...(deliveryConstraint === "text" ? { restartRecoverySuppressTextDelivery: true } : {}),
        mainRestartRecovery: {
          cycleId: recoveryCycleId,
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "delegated recovery sender authority is unavailable" },
        },
      }),
    },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId,
    sessionKey: key,
    storePath,
    messages: [
      { role: "user", content: "Finish the interrupted implementation." },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "completed-write", name: "write", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "completed-write",
        toolName: "write",
        content: [{ type: "text", text: "The requested file was written." }],
      },
    ],
  });
  const cfg = getRuntimeConfig();
  const config = {
    ...cfg,
    gateway: { ...cfg.gateway, roles: rolePolicyConfig().gateway!.roles },
    session: { ...cfg.session, store: storePath },
  };
  const executions: Promise<unknown>[] = [];
  const runRemoved = createDeferredCore();
  let runAdded = false;
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
    addChatRun: vi.fn(() => {
      runAdded = true;
      return undefined;
    }),
    removeChatRun: vi.fn(() => {
      runRemoved.resolve();
      return undefined;
    }),
    trackExecution: async (run) => {
      const execution = Promise.resolve().then(run);
      executions.push(execution);
      return await execution;
    },
  });
  const scope = { agentId: "main", sessionKey: key, sessionId, storePath };
  const transcript = () => loadTranscriptEvents({ ...scope, sessionId });
  return {
    key,
    sessionId,
    recoveryCycleId,
    storePath,
    scope,
    owner,
    operator,
    retainedMetadata,
    context,
    transcript,
    entry: () => loadSessionEntry(scope),
    drain: () => Promise.all([...executions, ...(runAdded ? [runRemoved.promise] : [])]),
  };
}

async function recover(
  current: Awaited<ReturnType<typeof fixture>>,
  options: {
    client?: GatewayRequestHandlerOptions["client"];
    hasCurrentClientAuthority?: () => boolean;
  } = {},
) {
  let response:
    | { ok: boolean; payload?: SessionsRecoverResult; error?: { code?: string; message?: string } }
    | undefined;
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `operator-resume-${requestSequence++}`,
      method: "sessions.recover",
      params: {
        agentId: "main",
        key: current.key,
        mode: "in-place",
        sessionId: current.sessionId,
        recoveryCycleId: current.recoveryCycleId,
      },
    },
    client: options.client ?? current.operator,
    context: current.context,
    isWebchatConnect: () => false,
    ...(options.hasCurrentClientAuthority
      ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
      : {}),
    respond: (ok, payload, error) => {
      response = { ok, payload: payload as SessionsRecoverResult | undefined, error };
    },
  });
  if (!response) {
    throw new Error("sessions.recover did not respond");
  }
  return response;
}

test.for([false, true])(
  "operator resume keeps session identity and admits one durable continuation (native: %s)",
  async (native, { signal }) => {
    const current = await fixture(
      native ? "native-resume" : "builtin-resume",
      native ? "codex" : undefined,
      true,
    );
    const before = await current.transcript();
    const dispatched = createDeferredCore();
    const finish = createDeferredCore();
    let calls = 0;
    dispatchInboundMessageMock.mockImplementation(async ({ ctx, replyOptions }) => {
      calls += 1;
      try {
        expect(ctx.SessionKey).toBe(current.key);
        expect(replyOptions?.operatorAuthority?.profileId).toBe(
          current.operator.authenticatedUserProfile!.profileId,
        );
        replyOptions?.operatorAuthority?.assertCurrent();
        expect(replyOptions?.forceRestartSafeTools).toBe(true);
        expect(current.entry()).toMatchObject({
          sessionId: current.sessionId,
          ...current.retainedMetadata,
        });
        expect(current.entry()?.mainRestartRecovery?.tombstone).toBeUndefined();
        const pending = await listSessionPendingInputs(current.scope);
        expect(pending.items).toHaveLength(1);
        expect(JSON.stringify(pending.items[0]?.message)).toContain("unknown outcome");
        expect(await current.transcript()).toEqual(before);
        dispatched.resolve();
        await finish.promise;
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      } catch (error) {
        dispatched.reject(error);
        throw error;
      }
    });
    let failure: Error | undefined;
    try {
      const results = await Promise.all([recover(current), recover(current)]);
      const resumed = results.find((result) => result.ok);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({
        ok: true,
        payload: {
          key: current.key,
          sessionId: current.sessionId,
          continuation: { status: "started" },
        },
      });
      expect(results.filter((result) => !result.ok)).toHaveLength(1);
      await withinTest(dispatched.promise, signal);
      const repeated = await recover(current);
      expect(repeated, JSON.stringify(repeated)).toMatchObject({
        ok: false,
      });
      expect(calls).toBe(1);
      expect((await listSessionPendingInputs(current.scope)).items).toHaveLength(1);
      expect(current.entry()?.archivedAt).toBeUndefined();
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Resume failed", { cause: error });
    } finally {
      finish.resolve();
      if (failure) {
        for (const active of current.context.chatAbortControllers.values()) {
          active.controller.abort(failure);
        }
      }
      try {
        await withinTest(current.drain(), signal);
      } catch (cleanupError) {
        failure = failure
          ? new AggregateError([failure, cleanupError], "Resume failed before cleanup settled", {
              cause: cleanupError,
            })
          : cleanupError instanceof Error
            ? cleanupError
            : new Error("Resume cleanup failed", { cause: cleanupError });
      }
    }
    if (failure) {
      throw failure;
    }
    expect(calls).toBe(1);
  },
);

test.for([undefined, "media", "message", "text"] as const)(
  "restricted CLI resume leaves its tombstone actionable without admitting input (%s)",
  async (deliveryConstraint) => {
    const current = await fixture(
      `cli-restricted-resume-${deliveryConstraint ?? "guarded"}`,
      "claude-cli",
      true,
      deliveryConstraint,
    );
    const previousRegistry = { ...getTestPluginRegistry() };
    setTestPluginRegistry({
      ...previousRegistry,
      cliBackends: [
        ...previousRegistry.cliBackends,
        {
          pluginId: "anthropic",
          source: "test",
          backend: {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "unused-fixture" },
          },
        },
      ],
    });
    try {
      const before = current.entry();
      if (!before) {
        throw new Error("CLI fixture session is missing");
      }
      expect(
        await resolveWorkerPlacementSessionRuntimeAsync({
          cfg: current.context.getRuntimeConfig(),
          entry: before,
          agentId: "main",
          sessionKey: current.key,
        }),
      ).toBe("claude-cli");
      const transcript = await current.transcript();
      const rejected = await recover(current);
      expect(rejected, JSON.stringify(rejected)).toMatchObject({
        ok: true,
        payload: {
          key: current.key,
          sessionId: current.sessionId,
          continuation: {
            status: "rejected",
            error: { details: { reason: "restart-safe-tools-unavailable" } },
          },
        },
      });
      expect(current.entry()).toEqual(before);
      expect(await current.transcript()).toEqual(transcript);
      expect((await listSessionPendingInputs(current.scope)).items).toEqual([]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      try {
        await current.drain();
      } finally {
        setTestPluginRegistry(previousRegistry);
      }
    }
  },
);

test.for(["sessionId", "recoveryCycleId"] as const)(
  "a stale resume %s cannot clear the current tombstone",
  async (field) => {
    const current = await fixture(`stale-${field}`);
    const before = current.entry();
    const transcript = await current.transcript();
    const rejected = await recover({ ...current, [field]: `previous-${field}` });
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ ok: false });
    expect(current.entry()).toEqual(before);
    expect(await current.transcript()).toEqual(transcript);
    expect((await listSessionPendingInputs(current.scope)).items).toEqual([]);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  },
);

test("operator resume rejects a foreign read-only caller without clearing the tombstone", async () => {
  const current = await fixture("denied-resume");
  const reader = roleClient("view", "resume-foreign-reader");
  const before = current.entry();
  const transcript = await current.transcript();
  const denied = await recover(current, { client: reader });
  expect(denied).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      details: { code: "SESSION_PARTICIPATION_REQUIRED" },
    },
  });
  expect(current.entry()).toEqual(before);
  expect(await current.transcript()).toEqual(transcript);
  expect((await listSessionPendingInputs(current.scope)).items).toEqual([]);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("operator revocation while resume waits for admission preserves the tombstone", async ({
  signal,
}) => {
  const current = await fixture("revoked-resume");
  const before = current.entry();
  const transcript = await current.transcript();
  const locked = createDeferredCore();
  const unlock = createDeferredCore();
  const admissionQueued = createDeferredCore();
  let authorized = true;
  const originalMutation = sessionLifecycle.runExclusiveSessionLifecycleMutation;
  const mutation = vi
    .spyOn(sessionLifecycle, "runExclusiveSessionLifecycleMutation")
    .mockImplementation((operation, params) => {
      const pending = originalMutation(operation, params);
      if (operation === "recovery-drain") {
        admissionQueued.resolve();
      }
      return pending;
    });
  const blocker = sessionLifecycle.runExclusiveSessionLifecycleMutation("recover", {
    scope: current.storePath,
    identities: [current.key, current.sessionId],
    run: async () => {
      locked.resolve();
      await unlock.promise;
    },
  });
  await locked.promise;
  const request = recover(current, {
    hasCurrentClientAuthority: () => authorized,
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        admissionQueued.promise,
        request,
        "Resume returned before entering lifecycle admission",
      ),
      signal,
    );
    authorized = false;
    unlock.resolve();
    await expect(request).rejects.toThrow("Gateway requester authority changed");
    expect(current.entry()).toEqual(before);
    expect(await current.transcript()).toEqual(transcript);
    expect((await listSessionPendingInputs(current.scope)).items).toEqual([]);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  } finally {
    authorized = false;
    unlock.resolve();
    mutation.mockRestore();
    await Promise.allSettled([blocker, request]);
  }
});
