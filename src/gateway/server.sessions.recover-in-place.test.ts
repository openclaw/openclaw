import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import type { SessionsRecoverResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { settleFailedWorkerRestartRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-failure.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import * as sessionLifecycle from "../sessions/session-controller.lifecycle.js";
import {
  listRpcSourceEntriesForSession,
  requestRpcSourceCancellation,
} from "../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { dispatchInboundMessageMock, writeSessionStore } from "./test-helpers.js";
import { getTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import * as sessionRuntime from "./worker-environments/placement-session-runtime.js";

afterEach(() => drainGlobalSingletonLifecycleState());
afterEach(() => resetSubagentRegistryForTests({ persist: false }));
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const prepareProfiles = useUserProfileCatalogForTest();
const emptyDispatch = () => ({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
beforeEach(async () => {
  await prepareProfiles();
  dispatchInboundMessageMock.mockReset().mockResolvedValue(emptyDispatch());
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
  const identity = { key, sessionId, recoveryCycleId };
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
  const transcript = () => loadTranscriptEvents(scope);
  return {
    ...identity,
    storePath,
    scope,
    operator,
    retainedMetadata,
    context,
    transcript,
    entry: () => loadSessionEntry(scope),
    async expectUnchangedAfter(entry = loadSessionEntry(scope)) {
      const events = await transcript();
      return async () => {
        expect(loadSessionEntry(scope)).toEqual(entry);
        expect(await transcript()).toEqual(events);
        expect((await listSessionPendingInputs(scope)).items).toEqual([]);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      };
    },
    drain: () => Promise.all([...executions, ...(runAdded ? [runRemoved.promise] : [])]),
  };
}

async function recover(
  current: Awaited<ReturnType<typeof fixture>>,
  options: {
    client?: GatewayRequestHandlerOptions["client"];
    hasCurrentClientAuthority?: () => boolean;
    mode?: "in-place" | "new-session";
    automaticIdentity?: boolean;
  } = {},
) {
  const { mode = "in-place", automaticIdentity, ...requestOptions } = options;
  const respond = vi.fn<Parameters<typeof handleGatewayRequest>[0]["respond"]>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `operator-resume-${requestSequence++}`,
      method: "sessions.recover",
      params: {
        agentId: "main",
        key: current.key,
        ...(!automaticIdentity
          ? { mode, sessionId: current.sessionId, recoveryCycleId: current.recoveryCycleId }
          : {}),
      },
    },
    ...requestOptions,
    client: options.client ?? current.operator,
    context: current.context,
    isWebchatConnect: () => false,
    respond,
  });
  const [ok, payload, error] = expectDefined(respond.mock.lastCall, "sessions.recover response");
  return { ok, payload: payload as SessionsRecoverResult | undefined, error };
}

test.for([
  "interrupted",
  "settled",
  "placement-failed",
  "ordinary-failed",
  "failed-replacement",
  "cancelled",
  "replacement",
  "cli-full",
  "cli-restricted",
] as const)(
  "sessions.recover resumes only the original native child owned by restart recovery (%s)",
  async (scenario, { signal }) => {
    const cli = scenario === "cli-full" || scenario === "cli-restricted";
    const failed =
      scenario === "placement-failed" ||
      scenario === "ordinary-failed" ||
      scenario === "failed-replacement";
    const terminal = scenario === "settled" || failed;
    const current = await fixture(`child-recovery-${scenario}`, cli ? "claude-cli" : undefined);
    if (cli) {
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
      onTestFinished(() => setTestPluginRegistry(previousRegistry));
    }
    const runId = `child-run-${scenario}`;
    const lifecycleRevision = `child-revision-${scenario}`;
    await patchSessionEntryCore(current.scope, () => ({
      mainRestartRecovery: undefined,
      status: scenario === "cancelled" ? "killed" : failed ? "failed" : "interrupted",
      abortedLastRun: failed ? undefined : true,
      lastRunId: runId,
      lifecycleRevision,
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:main",
      spawnDepth: 1,
      subagentRole: "leaf",
      permissionMode: scenario === "cli-full" ? "full" : "guarded",
      restartRecoveryForceSafeTools: true,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: `${runId}:user`,
      restartRecoveryDeliveryContext: { channel: "webchat", to: current.key },
      restartRecoverySourceIngress: "channel",
    }));
    const interrupted = createSubagentRunRecord({
      runId,
      childSessionKey: current.key,
      childAgentId: "main",
      childSessionIdentity: {
        sessionId:
          scenario === "replacement" || scenario === "failed-replacement"
            ? "retired-child-session"
            : current.sessionId,
        lifecycleRevision,
      },
      requesterAgentId: "main",
      execution: {
        status: terminal ? "terminal" : "interrupted",
        startedAt: 1,
        interruptionReason: failed ? undefined : "gateway-restart",
        ...(terminal
          ? { endedAt: 2, outcome: { status: "error", error: "Interrupted by Gateway restart" } }
          : {}),
      },
      ...(terminal && scenario !== "ordinary-failed"
        ? { endedReason: "subagent-error", terminalOwner: "interrupted-recovery" }
        : {}),
    });
    await mutateSubagentRuns([runId], () => ({
      value: undefined,
      postimages: new Map([[runId, interrupted]]),
    }));
    const before = await current.transcript();
    const entryBefore = current.entry();
    const response = await recover(current, { automaticIdentity: true });
    if (
      scenario === "cancelled" ||
      scenario === "replacement" ||
      scenario === "failed-replacement" ||
      scenario === "ordinary-failed"
    ) {
      expect(response).toMatchObject({ ok: false });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(await current.transcript()).toEqual(before);
      return;
    }
    if (scenario === "cli-restricted") {
      expectContinuation(current, response, {
        status: "rejected",
        error: { details: { reason: "restart-safe-tools-unavailable" } },
      });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(current.entry()).toEqual(entryBefore);
      expect(await current.transcript()).toEqual(before);
      expect((await listSessionPendingInputs(current.scope)).items).toEqual([]);
      return;
    }
    expectContinuation(current, response, { status: "started", runId: expect.any(String) });
    await withinTest(current.drain(), signal);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(dispatchInboundMessageMock.mock.calls[0]?.[0]).toMatchObject({
      ctx: { SessionKey: current.key },
      replyOptions: { forceRestartSafeTools: scenario !== "cli-full" },
    });
    expect(current.entry()).toMatchObject({ sessionId: current.sessionId, lifecycleRevision });
    expect(current.entry()?.mainRestartRecovery).toBeUndefined();
    expect(current.entry()?.archivedAt).toBeUndefined();
    expect(current.entry()?.restartRecoveryTerminalRunIds).toContain(`${runId}:user`);
  },
);

function expectContinuation(
  current: Awaited<ReturnType<typeof fixture>>,
  response: unknown,
  continuation: Record<string, unknown>,
) {
  expect(response, JSON.stringify(response)).toMatchObject({
    ok: true,
    payload: { key: current.key, sessionId: current.sessionId, continuation },
  });
}

test.for(["none", "ownerless", "intent", "deliveries"] as const)(
  "operator resume after failed worker settlement preserves delivery custody (%s)",
  async (savedFinal, { signal }) => {
    const current = await fixture(`failed-worker-${savedFinal}`);
    const pending =
      savedFinal === "none"
        ? undefined
        : {
            kind: "replayable" as const,
            text: "Retained answer before worker setup failed.",
            createdAt: 100,
            ...(savedFinal === "intent" ? { intentId: "owned-delivery" } : {}),
            ...(savedFinal === "deliveries"
              ? { deliveries: [{ id: "owned-delivery", state: "prepared" as const }] }
              : {}),
          };
    await patchSessionEntryCore(current.scope, () => ({
      status: "interrupted",
      abortedLastRun: true,
      pendingFinalDelivery: pending,
      mainRestartRecovery: {
        cycleId: current.recoveryCycleId,
        revision: 4,
        chargedAttempts: 0,
      },
    }));
    const entry = expectDefined(current.entry(), "failed worker recovery source");
    const reason = "Worker setup failed. Repair it before resuming.";
    expect(
      await settleFailedWorkerRestartRecovery({
        ...current.scope,
        placementSessionKey: current.key,
        entry,
        observation: {
          sessionId: current.sessionId,
          cycleId: current.recoveryCycleId,
          revision: 4,
        },
        gatewayRuntime: createMockGatewayRecoveryRuntime({
          prepareFailedWorkerPlacement: async () => ({
            reason,
            isCurrent: () => true,
            release: () => {},
          }),
        }),
      }),
    ).toBe("settled");
    const response = await recover(current);
    if (savedFinal === "intent" || savedFinal === "deliveries") {
      expect(response).toMatchObject({
        ok: false,
        error: { message: "Finish the pending reply delivery before resuming this session." },
      });
      expect(current.entry()?.pendingFinalDelivery).toEqual(pending);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      return;
    }
    expectContinuation(current, response, { status: "started" });
    await withinTest(current.drain(), signal);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(current.entry()?.pendingFinalDelivery).toBeUndefined();
    if (pending) {
      const transcript = JSON.stringify(await current.transcript());
      expect(transcript).toContain("Saved reply (delivery unconfirmed)");
      expect(transcript).toContain(pending.text);
    }
  },
);

test.for(["builtin", "native", "pending", "pending-child"] as const)(
  "operator resume keeps session identity and admits one durable continuation (%s)",
  async (scenario, { signal }) => {
    const native = scenario === "native";
    const current = await fixture(`${scenario}-resume`, native ? "codex" : undefined, true);
    if (scenario === "pending" || scenario === "pending-child") {
      await patchSessionEntryCore(current.scope, () => ({
        ...(scenario === "pending-child"
          ? {
              spawnDepth: 1,
              spawnedBy: "agent:requester:discord:group:synthetic",
              parentSessionKey: "agent:requester:discord:group:synthetic",
            }
          : {}),
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: current.recoveryCycleId,
          revision: 4,
          chargedAttempts: 0,
        },
      }));
    }
    const before = await current.transcript();
    const dispatched = createDeferredCore();
    const finish = createDeferredCore();
    dispatchInboundMessageMock.mockImplementation(async ({ ctx, replyOptions }) => {
      try {
        expect(ctx).toMatchObject({ SessionKey: current.key });
        expect(replyOptions).toMatchObject({
          operatorAuthority: { profileId: current.operator.authenticatedUserProfile!.profileId },
          forceRestartSafeTools: true,
        });
        replyOptions?.operatorAuthority?.assertCurrent();
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
        return emptyDispatch();
      } catch (error) {
        dispatched.reject(error);
        throw error;
      }
    });
    const failures: unknown[] = [];
    try {
      const results = await Promise.all([recover(current), recover(current)]);
      const resumed = results.find((result) => result.ok);
      expectContinuation(current, resumed, { status: "started" });
      expect(results.filter((result) => !result.ok)).toHaveLength(1);
      await withinTest(dispatched.promise, signal);
      const repeated = await recover(current);
      expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: false });
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect((await listSessionPendingInputs(current.scope)).items).toHaveLength(1);
      expect(current.entry()?.archivedAt).toBeUndefined();
    } catch (error) {
      failures.push(error);
    } finally {
      finish.resolve();
      if (failures.length) {
        for (const { entry } of listRpcSourceEntriesForSession({
          sessionKeys: [current.key],
          sessionIds: [current.sessionId],
          agentId: "main",
          storeScope: current.storePath,
        })) {
          requestRpcSourceCancellation(entry, failures[0]);
        }
      }
      try {
        await withinTest(current.drain(), signal);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Resume or cleanup failed");
    }
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  },
);

test.for([undefined, "media", "message", "text", "pending", "pending-revoked"] as const)(
  "restricted CLI resume preserves actionable recovery (%s)",
  async (scenario) => {
    const pending = scenario === "pending" || scenario === "pending-revoked";
    const deliveryConstraint = pending ? undefined : scenario;
    const current = await fixture(
      `cli-restricted-resume-${scenario ?? "guarded"}`,
      "claude-cli",
      true,
      deliveryConstraint,
    );
    if (pending) {
      await patchSessionEntryCore(current.scope, () => ({
        status: "interrupted",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: current.recoveryCycleId,
          revision: 4,
          chargedAttempts: 0,
        },
      }));
    }
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
        await sessionRuntime.resolveWorkerPlacementSessionRuntimeAsync({
          cfg: current.context.getRuntimeConfig(),
          entry: before,
          agentId: "main",
          sessionKey: current.key,
        }),
      ).toBe("claude-cli");
      const expectUnchanged = await current.expectUnchangedAfter(before);
      if (scenario === "pending-revoked") {
        let authorized = true;
        const resolveRuntime = sessionRuntime.resolveWorkerPlacementSessionRuntimeAsync;
        const runtime = vi
          .spyOn(sessionRuntime, "resolveWorkerPlacementSessionRuntimeAsync")
          .mockImplementation(async (params) => {
            const resolved = await resolveRuntime(params);
            authorized = false;
            return resolved;
          });
        try {
          await expect(
            recover(current, { hasCurrentClientAuthority: () => authorized }),
          ).rejects.toThrow("Gateway requester authority changed");
          await expectUnchanged();
        } finally {
          runtime.mockRestore();
        }
        return;
      }
      const transcript = await current.transcript();
      const rejected = await recover(current);
      expectContinuation(current, rejected, {
        status: "rejected",
        error: { details: { reason: "restart-safe-tools-unavailable" } },
      });
      if (scenario === "pending") {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect((await listSessionPendingInputs(current.scope)).items).toEqual([]);
        expect(await current.transcript()).toEqual(transcript);
        const rollover = await recover(current, { mode: "new-session" });
        expect(rollover, JSON.stringify(rollover.error)).toMatchObject({
          ok: true,
          payload: { continuation: { status: "started" } },
        });
        expect(rollover.payload?.key).not.toBe(current.key);
        expect(current.entry()?.archivedAt).toBeDefined();
        expect(await current.transcript()).toEqual(transcript);
      } else {
        await expectUnchanged();
      }
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
    const expectUnchanged = await current.expectUnchangedAfter();
    const rejected = await recover({ ...current, [field]: `previous-${field}` });
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ ok: false });
    await expectUnchanged();
  },
);

test("operator resume rejects a foreign read-only caller without clearing the tombstone", async () => {
  const current = await fixture("denied-resume");
  const reader = roleClient("view", "resume-foreign-reader");
  const expectUnchanged = await current.expectUnchangedAfter();
  const denied = await recover(current, { client: reader });
  expect(denied).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      details: { code: "SESSION_PARTICIPATION_REQUIRED" },
    },
  });
  await expectUnchanged();
});

test("operator revocation while resume waits for admission preserves the tombstone", async ({
  signal,
}) => {
  const current = await fixture("revoked-resume");
  const expectUnchanged = await current.expectUnchangedAfter();
  const locked = createDeferredCore();
  const unlock = createDeferredCore();
  const admissionQueued = createDeferredCore();
  let authorized = true;
  const blocker = sessionLifecycle.runSessionMutation({
    target: sessionLifecycle.captureSessionTarget({
      storeScope: current.storePath,
      sessionKey: current.key,
      incarnation: current.sessionId,
      agentId: "main",
    }),
    run: async () => {
      locked.resolve();
      await unlock.promise;
    },
  });
  await locked.promise;
  const originalMutation = sessionLifecycle.runSessionMutation;
  const mutation = vi.spyOn(sessionLifecycle, "runSessionMutation").mockImplementation((params) => {
    const pending = originalMutation(params);
    admissionQueued.resolve();
    return pending;
  });
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
    await expectUnchanged();
  } finally {
    authorized = false;
    unlock.resolve();
    mutation.mockRestore();
    await Promise.allSettled([blocker, request]);
  }
});
