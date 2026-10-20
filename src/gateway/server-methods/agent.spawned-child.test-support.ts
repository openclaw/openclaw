import path from "node:path";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { getSubagentRunByChildSessionKeyFromRuns } from "../../agents/subagents/registry/subagent-registry-queries.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  writeSubagentSessionEntry,
  settleSubagentRegistryPersistenceWork,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { writeSubagentRunValuesInDatabase } from "../../agents/subagents/registry/subagent-registry.store.kernel.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
} from "../../infra/agent-run-registry.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  requestRpcSourceCancellation,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveAgentTestConfig } from "./agent.mocks.test-utils.js";
import { settleAgentSubagentWakeRoots } from "./agent.subagent-registry.mocks.test-support.js";
import {
  type AgentHandlerArgs,
  getAgentTestMocks,
  backendGatewayClient,
  requireValue,
  makeContext,
  invokeAgent,
  waitForAgentCommandCall,
  waitForAgentCommandCallAfter,
  expectRespondError,
  expectRecordFields,
  useTestStateDir,
} from "./agent.test-harness.js";

export const confirmedAcpMeta: SessionAcpMeta = {
  backend: "acpx",
  agent: "codex",
  runtimeSessionName: "runtime-1",
  mode: "persistent",
  state: "idle",
  lastActivityAt: Date.now(),
};

export function mockGlobalSessionAgentRoster() {
  const mocks = getAgentTestMocks();
  mocks.listAgentIds.mockReturnValue(["main", "work"]);
  mocks.loadConfigReturn = {
    agents: { entries: { main: {}, work: {} } },
    session: { scope: "global" },
  };
}

export function nativeSubagentClient(): AgentHandlerArgs["client"] {
  const baseClient = requireValue(backendGatewayClient(), "expected backend client");
  return {
    connect: baseClient.connect,
    internal: { ...baseClient.internal, agentRunTracking: "native_subagent" },
  };
}

export function observeAgentSubagentCleanup(params: { runId: string; childSessionKey: string }) {
  const cleanupCompleted = createDeferred();
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
    const entry = subagentRuns.get(params.runId);
    if (entry?.childSessionKey === params.childSessionKey && entry.cleanupCompletedAt) {
      cleanupCompleted.resolve();
    }
  });
  return {
    cleanupCompleted: cleanupCompleted.promise,
    [Symbol.dispose]: unsubscribe,
  };
}

export function createPluginSubagentTestLifetime(params: {
  root: string;
  runId: string;
  childSessionKey: string;
}) {
  getAgentTestMocks().registryCallGateway.mockImplementation(async () => ({
    status: "ok",
    startedAt: Date.now(),
    endedAt: Date.now(),
  }));
  const work = new AsyncWorkScope();
  const cleanup = observeAgentSubagentCleanup(params);
  return {
    work,
    cleanupCompleted: cleanup.cleanupCompleted,
    async [Symbol.asyncDispose]() {
      cleanup[Symbol.dispose]();
      await work.drain();
      await resetSubagentRegistryForTests({ persist: false });
      await settleSubagentRegistryPersistenceWork(settleAgentSubagentWakeRoots);
      await cleanupSessionStateForTest({ stateDir: params.root });
    },
  };
}

/** Seed the paused owner's durable row and published projection together. */
export async function seedPersistedSubagentRunForAgentTest(
  overrides: Parameters<typeof addSubagentRunForTests>[0],
) {
  await addSubagentRunForTests(overrides);
}

// Shared by spawned-child handler fixtures; real transcript reads stay in the fixture root.
export function mockSpawnedChildSessionEntry(childSessionKey: string, root: string) {
  const mocks = getAgentTestMocks();
  mocks.userTurnStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  mocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    storePath: mocks.userTurnStorePath,
    entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
    canonicalKey: childSessionKey,
  });
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

/** Join native registry completions before retiring temporary state and database owners. */
export async function withPluginSubagentTestState(
  prefix: string,
  run: (state: Awaited<ReturnType<typeof createOpenClawTestState>>) => Promise<void>,
): Promise<void> {
  const state = await createOpenClawTestState({ prefix, layout: "state-only" });
  try {
    setRuntimeConfigSnapshot(resolveAgentTestConfig());
    await resetSubagentRegistryForTests({ persist: false });
    await run(state);
  } finally {
    // Stop producers, then join admitted work before deleting storage. A failed join retains it.
    await resetSubagentRegistryForTests({ persist: false });
    await settleSubagentRegistryPersistenceWork(settleAgentSubagentWakeRoots);
    await resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    await state.cleanup();
  }
}

export function seedReleasedYieldedSubagentRun(params: {
  previousRunId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  storePath: string;
  budget: number;
}): void {
  const { previousRunId, childSessionKey, requesterSessionKey, storePath, budget } = params;
  // Frozen v2026.9.6 (eb377ac59e6c) codec/normalizer output after sessions_yield.
  // Seed the released bytes without passing through the candidate's serializer.
  runOpenClawStateWriteTransaction((database) =>
    writeSubagentRunValuesInDatabase(
      database,
      [
        {
          run_id: previousRunId,
          child_session_key: childSessionKey,
          controller_session_key: requesterSessionKey,
          requester_session_key: requesterSessionKey,
          requester_store_path: storePath,
          controller_store_path: storePath,
          created_at: 1,
          payload_json: JSON.stringify({
            runId: previousRunId,
            taskRunId: previousRunId,
            childSessionKey,
            controllerSessionKey: requesterSessionKey,
            requesterSessionKey,
            requesterStorePath: storePath,
            controllerStorePath: storePath,
            requesterDisplayKey: requesterSessionKey,
            requesterAgentId: "main",
            task: "Review the candidate",
            cleanup: "keep",
            expectsCompletionMessage: true,
            spawnMode: "run",
            runTimeoutSeconds: budget,
            generation: 1,
            createdAt: 1,
            execution: {
              status: "terminal",
              startedAt: 1,
              endedAt: 2,
              lifecycleGeneration: "released-generation",
            },
            completion: { required: true },
            delivery: { status: "pending" },
            sessionStartedAt: 1,
            accumulatedRuntimeMs: 0,
            cleanupHandled: false,
            pauseReason: "sessions_yield",
          }),
        },
      ],
      [],
    ),
  );
}

export function registerPluginSubagentToolForwardingTests() {
  it.each([
    {
      label: "plugin-owned additive tools",
      runId: "plugin-tools-also-allow",
      pluginRuntimeOwnerId: "workboard",
      runtimePluginToolGrant: {
        pluginId: "workboard",
        toolNames: ["workboard_heartbeat", "workboard_complete"],
      },
      pluginSubagentToolsAllow: undefined,
    },
    {
      label: "an exact empty tool cap",
      runId: "plugin-tools-disabled",
      pluginRuntimeOwnerId: "memory-core",
      runtimePluginToolGrant: undefined,
      pluginSubagentToolsAllow: [],
    },
  ])("forwards $label for tracked plugin subagent runs", async (scenario) => {
    await withPluginSubagentTestState(
      "openclaw-plugin-tool-forwarding-",
      async ({ stateDir: root }) => {
        const childSessionKey = `agent:main:subagent:${scenario.runId}`;
        await writeSubagentSessionEntry({
          stateDir: root,
          agentId: "main",
          sessionKey: childSessionKey,
          defaultSessionId: "spawned-child-session",
        });
        mockSpawnedChildSessionEntry(childSessionKey, root);
        await using fixture = createPluginSubagentTestLifetime({
          root,
          runId: scenario.runId,
          childSessionKey,
        });
        const context = makeContext();
        context.trackExecution = (run) => fixture.work.track(run);
        await fixture.work.track(() =>
          invokeAgent(
            {
              message: "Complete the plugin task",
              sessionKey: childSessionKey,
              idempotencyKey: scenario.runId,
            },
            {
              context,
              client: createSyntheticPluginRuntimeClient({
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: scenario.pluginRuntimeOwnerId,
                ...(scenario.runtimePluginToolGrant
                  ? { runtimePluginToolGrant: scenario.runtimePluginToolGrant }
                  : {}),
                ...(scenario.pluginSubagentToolsAllow
                  ? { pluginSubagentToolsAllow: scenario.pluginSubagentToolsAllow }
                  : {}),
              }),
            },
          ),
        );
        const call = await waitForAgentCommandCall<{
          runtimePluginToolGrant?: { pluginId: string; toolNames: readonly string[] };
          toolsAllow?: string[];
        }>();
        if (scenario.runtimePluginToolGrant) {
          expect(call.runtimePluginToolGrant).toEqual({
            pluginId: "workboard",
            toolNames: ["workboard_heartbeat", "workboard_complete"],
          });
        } else {
          expect(call.toolsAllow).toEqual([]);
        }
        await fixture.cleanupCompleted;
      },
    );
  });
}

export function registerPluginSubagentAdmissionTests() {
  const mocks = getAgentTestMocks();
  it.each([
    { identity: "ASCII", runId: "plugin-subagent-task-run", inputFailure: false },
    { identity: "astral prefix", runId: "abc😀" + "x".repeat(10), inputFailure: false },
    { identity: "astral suffix", runId: "x".repeat(10) + "😀abc", inputFailure: false },
    {
      identity: "astral prefix and suffix",
      runId: "abc😀" + "x".repeat(10) + "😀xyz",
      inputFailure: false,
    },
    { identity: "rejected input", runId: "plugin-subagent-input-failure", inputFailure: true },
  ])(
    "tracks plugin subagent $identity runs through the registry",
    async ({ runId, inputFailure }) => {
      await withTestDir({ prefix: "openclaw-gateway-plugin-subagent-task-" }, async (root) => {
        useTestStateDir(root);
        await resetSubagentRegistryForTests({ persist: false });
        const childSessionKey = "agent:work:subagent:plugin-helper";
        await using fixture = createPluginSubagentTestLifetime({ root, runId, childSessionKey });
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" },
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-sonnet-4-6" },
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
              },
            },
            entries: { main: {}, work: {} },
          },
        } satisfies typeof mocks.loadConfigReturn;
        mocks.listAgentIds.mockReturnValue(["main", "work"]);
        mocks.loadConfigReturn = cfg;
        mocks.userTurnStorePath = await writeSubagentSessionEntry({
          stateDir: root,
          agentId: "work",
          sessionKey: childSessionKey,
          defaultSessionId: "plugin-subagent-session",
        });
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath: mocks.userTurnStorePath,
          entry: {
            sessionId: "plugin-subagent-session",
            updatedAt: Date.now(),
          },
          canonicalKey: childSessionKey,
        });
        const { patchSessionEntryTarget } = await vi.importActual<
          typeof import("../../config/sessions/session-accessor.sqlite-entry.js")
        >("../../config/sessions/session-accessor.sqlite-entry.js");
        mocks.patchSessionEntryTarget.mockImplementation(patchSessionEntryTarget);
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });
        const context = makeContext();
        context.trackExecution = (run) => fixture.work.track(run);
        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const pluginClient: AgentHandlerArgs["client"] = {
          connect: baseClient.connect,
          internal: {
            ...baseClient.internal,
            agentRunTracking: "plugin_subagent",
            pluginRuntimeOwnerId: "memory-core",
          },
        };
        const initialCommandCallCount = mocks.agentCommand.mock.calls.length;
        if (inputFailure) {
          mocks.stageSessionPendingInput.mockRejectedValueOnce(
            new Error("plugin input admission failed"),
          );
        }

        const respond = await fixture.work.track(() =>
          invokeAgent(
            {
              message: "background plugin subagent task",
              sessionKey: childSessionKey,
              idempotencyKey: runId,
            },
            {
              context,
              reqId: runId,
              client: pluginClient,
            },
          ),
        );
        if (inputFailure) {
          expectRespondError(respond, {
            code: ErrorCodes.UNAVAILABLE,
            message: "plugin input admission failed",
          });
          expect(mocks.agentCommand).toHaveBeenCalledTimes(initialCommandCallCount);
          expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
          expect(getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey)).toBeNull();
          expect(rpcSourceTesting.has(runId)).toBe(false);
          return;
        }
        await waitForAgentCommandCallAfter(initialCommandCallCount);

        const acceptedPayload = respond.mock.calls.find(
          ([ok, payload]) =>
            ok === true &&
            typeof payload === "object" &&
            payload !== null &&
            "status" in payload &&
            payload.status === "accepted",
        )?.[1];
        expect(acceptedPayload).toMatchObject({
          runtime: {
            harness: "claude-cli",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        });

        await fixture.cleanupCompleted;

        expectRecordFields(getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey), {
          cleanupCompletedAt: expect.any(Number),
        });
        const run = requireValue(
          getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey),
          "expected subagent registry run",
        );
        expectRecordFields(run, {
          runId,
          childSessionKey,
          controllerSessionKey: "agent:work:main",
          requesterSessionKey: "agent:work:main",
          requesterDisplayKey: "main",
          cleanup: "keep",
          spawnMode: "run",
          label: "plugin:memory-core",
        });
        expectRecordFields(run.completion, { required: false });
        expectRecordFields(run.delivery, { status: "not_required" });

        const commandCallCount = mocks.agentCommand.mock.calls.length;
        const createdAt = run.createdAt;
        await fixture.work.track(() =>
          invokeAgent(
            {
              message: "background plugin subagent task",
              sessionKey: childSessionKey,
              idempotencyKey: runId,
            },
            {
              context,
              reqId: `${runId}-retry`,
              client: pluginClient,
            },
          ),
        );

        await fixture.work.runWhenIdle(() => {
          expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
          expect(
            getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey)?.createdAt,
          ).toBe(createdAt);
        });
      });
    },
  );

  it.each(["fresh", "paused", "replacement"] as const)(
    "settles rejected %s plugin registration without touching a replacement",
    async (kind) => {
      await withPluginSubagentTestState(
        "openclaw-plugin-rejected-registration-",
        async ({ stateDir: root }) => {
          const runId = `plugin-postcommit-${kind}`;
          const registry = await vi.importActual<
            typeof import("../../infra/agent-run-registry.js")
          >("../../infra/agent-run-registry.js");
          const previousContextMocks = {
            lifecycleGeneration: mocks.lifecycleGeneration,
            register: mocks.registerAgentRunContext.getMockImplementation(),
            clear: mocks.clearAgentRunContext.getMockImplementation(),
            get: vi.mocked(getAgentRunContext).getMockImplementation(),
          };
          using _ = {
            [Symbol.dispose]() {
              registry.clearAgentRunContext(runId);
              mocks.lifecycleGeneration = previousContextMocks.lifecycleGeneration;
              mocks.registerAgentRunContext.mockImplementation(
                previousContextMocks.register ?? (() => undefined),
              );
              mocks.clearAgentRunContext.mockImplementation(
                previousContextMocks.clear ?? (() => undefined),
              );
              vi.mocked(getAgentRunContext).mockImplementation(
                previousContextMocks.get ?? (() => undefined),
              );
            },
          };
          mocks.lifecycleGeneration = registry.getAgentRunLifecycleGeneration();
          vi.mocked(getAgentRunContext).mockImplementation(registry.getAgentRunContext);
          mocks.clearAgentRunContext.mockImplementation(registry.clearAgentRunContext);
          mocks.registerAgentRunContext.mockImplementation((registeredRunId, context, options) =>
            typeof options === "object"
              ? registry.claimAgentRunContext(registeredRunId, context, options)
              : registry.registerAgentRunContext(registeredRunId, context, options),
          );
          const childSessionKey = "agent:main:subagent:postcommit";
          const previousRunId = "plugin-before-adoption";
          const requesterSessionKey = "agent:main:telegram:direct:777";
          const completion = createDeferred<AgentWaitResult>();
          const cleanupCompleted = createDeferred();
          mocks.registryCallGateway.mockReturnValue(completion.promise);
          mocks.registryAnnounce.mockResolvedValue("delivered");
          mocks.registryWake.mockResolvedValue(false);
          if (kind !== "fresh") {
            await seedPersistedSubagentRunForAgentTest({
              runId: previousRunId,
              childSessionKey,
              requesterSessionKey,
              requesterDisplayKey: requesterSessionKey,
              task: "Wait for the next result",
              endedAt: Date.now(),
              pauseReason: "sessions_yield",
              expectsCompletionMessage: true,
              requesterSettleWake: {
                status: "pending",
                attemptCount: 0,
                requesterYieldBatch: true,
                rearmGeneration: 7,
                batchRunIds: [previousRunId],
              },
            });
          }
          await writeSubagentSessionEntry({
            stateDir: root,
            agentId: "main",
            sessionKey: childSessionKey,
            defaultSessionId: "spawned-child-session",
          });
          mockSpawnedChildSessionEntry(childSessionKey, root);
          const context = makeContext();
          const baseClient = requireValue(backendGatewayClient(), "backend fixture client");
          const commandCallCount = mocks.agentCommand.mock.calls.length;
          let committed = false;
          let replacement: ReturnType<typeof createSubagentRunRecord> | undefined;
          let replacementPersisted: ReturnType<typeof loadSubagentRegistryFromSqlite> | undefined;
          let replacementContext: ReturnType<typeof getAgentRunContext>;
          let replacementController: ReturnType<typeof registerChatAbortController> | undefined;
          const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
            const entry = getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey);
            if (entry?.runId === runId && entry.cleanupCompletedAt !== undefined) {
              cleanupCompleted.resolve();
            }
            if (committed || entry?.runId !== runId || entry.execution.endedAt !== undefined) {
              return;
            }
            committed = true;
            const admitted = requireValue(rpcSourceTesting.get(runId), "admitted controller");
            requestRpcSourceCancellation(admitted);
            if (kind === "replacement") {
              replacement = createSubagentRunRecord({
                ...entry,
                generation: (entry.generation ?? 0) + 1,
                createdAt: entry.createdAt + 1,
                task: "Independently admitted replacement",
              });
              subagentRuns.set(runId, replacement);
              persistRegistryFixture(subagentRuns, [runId]);
              replacementPersisted = loadSubagentRegistryFromSqlite();
              rpcSourceTesting.deleteExpected(runId, admitted);
              clearAgentRunContext(runId, getRpcSourceLifecycleGeneration(admitted));
              replacementController = registerChatAbortController({
                target: admitted.input.target,
                runId,
                sessionId: requireValue(
                  getRpcSourceIdentity(admitted).sessionId,
                  "admitted session",
                ),
                sessionKey: childSessionKey,
                timeoutMs: 0,
                kind: "agent",
                lifecycleGeneration: getRpcSourceLifecycleGeneration(admitted),
                operationalRunInstance: createOperationalRunInstanceRef(runId),
              });
              claimAgentRunContext(runId, {
                sessionKey: childSessionKey,
                lifecycleGeneration: getRpcSourceLifecycleGeneration(admitted),
              });
              replacementContext = getAgentRunContext(runId);
            }
          });
          try {
            const respond = await invokeAgent(
              { message: "Continue the task", sessionKey: childSessionKey, idempotencyKey: runId },
              {
                context,
                reqId: runId,
                client: {
                  connect: baseClient.connect,
                  internal: { ...baseClient.internal, agentRunTracking: "plugin_subagent" },
                },
              },
            );
            expect(committed).toBe(true);
            expect(respond).toHaveBeenCalled();
            expect(respond.mock.calls.map(([, payload]) => payload)).not.toEqual(
              expect.arrayContaining([expect.objectContaining({ status: "accepted" })]),
            );
            expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
            let persisted = loadSubagentRegistryFromSqlite();
            if (kind === "replacement") {
              expect(replacement).toBeDefined();
              expect(replacementPersisted?.has(runId)).toBe(true);
              expect(replacementContext).toBeDefined();
              expect(replacementController?.registered).toBe(true);
              expect(
                getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey),
              ).toEqual(replacement);
              expect(persisted.get(runId)).toEqual(replacementPersisted?.get(runId));
              expect(getAgentRunContext(runId)).toBe(replacementContext);
              expect(rpcSourceTesting.get(runId)).toBe(replacementController?.entry);
            } else {
              expect(persisted.get(runId)?.execution).toMatchObject({
                status: "terminal",
                endedAt: expect.any(Number),
                outcome: { status: "error" },
              });
              await cleanupCompleted.promise;
              persisted = loadSubagentRegistryFromSqlite();
              expect(persisted.get(runId)).toMatchObject({
                cleanupCompletedAt: expect.any(Number),
                execution: { status: "terminal", outcome: { status: "error" } },
              });
              expect(
                getSubagentRunByChildSessionKeyFromRuns(subagentRuns, childSessionKey)?.execution,
              ).toEqual(persisted.get(runId)?.execution);
              expect(rpcSourceTesting.has(runId)).toBe(false);
              expect(getAgentRunContext(runId)).toBeUndefined();
            }
            if (kind !== "fresh") {
              expect(persisted.has(previousRunId)).toBe(false);
              expect(persisted.get(runId)).toMatchObject({
                taskRunId: previousRunId,
                requesterSessionKey,
                requesterDisplayKey: requesterSessionKey,
                completion: { required: true },
                requesterSettleWake: {
                  requesterYieldBatch: true,
                  rearmGeneration: 7,
                  batchRunIds: [runId],
                },
              });
            }
          } finally {
            unsubscribe();
            replacementController?.cleanup();
            clearAgentRunContext(runId);
            completion.resolve({ status: "ok", startedAt: Date.now(), endedAt: Date.now() });
          }
        },
      );
    },
  );
}
