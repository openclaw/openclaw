import path from "node:path";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import {
  onSubagentRegistryPersisted,
  persistSubagentRunsToDiskOrThrow,
} from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  createCanonicalSubagentRunFixture,
  settleSubagentRegistryPersistenceWork,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  type AgentHandlerArgs,
  getAgentTestMocks,
  backendGatewayClient,
  requireValue,
} from "./agent.test-harness.js";

export const confirmedAcpMeta: NonNullable<ReturnType<typeof readAcpSessionMeta>> = {
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
  const cleanupCompleted = createDeferred();
  const unsubscribe = onSubagentRegistryPersisted(() => {
    const entry = getSubagentRunByChildSessionKey(params.childSessionKey);
    if (entry?.runId === params.runId && entry.cleanupCompletedAt) {
      cleanupCompleted.resolve();
    }
  });
  return {
    work,
    cleanupCompleted: cleanupCompleted.promise,
    async [Symbol.asyncDispose]() {
      unsubscribe();
      await work.drain();
      resetSubagentRegistryForTests({ persist: false });
      await cleanupSessionStateForTest({ stateDir: params.root });
    },
  };
}

/** Native replacement compares the complete paused owner with its durable source row. */
export function seedPersistedSubagentRunForAgentTest(
  overrides: Parameters<typeof addSubagentRunForTests>[0],
) {
  const entry = createCanonicalSubagentRunFixture({
    ...createSubagentRunRecord(overrides),
    endedAt: overrides.endedAt,
  });
  // The registry fixture binds physical requester/controller stores before persistence.
  addSubagentRunForTests(entry);
  persistSubagentRunsToDiskOrThrow(new Map([[entry.runId, entry]]), [entry.runId]);
  return entry;
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
    resetSubagentRegistryForTests({ persist: false });
    await run(state);
  } finally {
    // Stop producers, then join admitted work before deleting storage. A failed join retains it.
    resetSubagentRegistryForTests({ persist: false });
    await vi.dynamicImportSettled();
    await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    await state.cleanup();
  }
}
