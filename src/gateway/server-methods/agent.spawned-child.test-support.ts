import path from "node:path";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { writeSubagentRunValuesInDatabase } from "../../agents/subagents/registry/subagent-registry.store.kernel.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  type AgentHandlerArgs,
  getAgentTestMocks,
  backendGatewayClient,
  requireValue,
} from "./agent.test-harness.js";

export const confirmedAcpMeta: SessionAcpMeta = {
  backend: "acpx",
  agent: "codex",
  runtimeSessionName: "runtime-1",
  mode: "persistent",
  state: "idle",
  lastActivityAt: Date.now(),
};

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
    await resetSubagentRegistryForTests({ persist: false });
    await run(state);
  } finally {
    // Stop producers, then join admitted work before deleting storage. A failed join retains it.
    await resetSubagentRegistryForTests({ persist: false });
    await vi.dynamicImportSettled();
    await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    await settleSubagentRegistryPersistenceWork();
    await resetSubagentRegistryForTests({ persist: false });
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
