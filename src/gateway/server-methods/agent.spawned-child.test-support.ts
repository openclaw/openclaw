import { createDeferred } from "../../../test/helpers/promise.js";
import type { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import type { SubagentRegistryDeps } from "../../agents/subagents/registry/subagent-registry-deps.js";
import { onSubagentRegistryPersisted } from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  type AgentHandlerArgs,
  applyGatewaySubagentRegistryTestDeps,
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
  applyGatewaySubagentRegistryTestDeps({
    callGateway: (async () => ({
      status: "ok",
      startedAt: Date.now(),
      endedAt: Date.now(),
    })) as SubagentRegistryDeps["callGateway"],
  });
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
