import "../subagents/registry/subagent-registry.mocks.shared.js";
import assert from "node:assert/strict";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../browser-lifecycle-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { callGateway } from "../../gateway/call.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { createOpenClawToolsAsync } from "../openclaw-tools.js";
import { loadAgentRuntimePluginRegistryHandle } from "../runtime-plugins.js";
import { configureMockSubagentRegistryPersistence } from "../subagent-test-fixtures.test-helpers.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../subagents/announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../subagents/announce/subagent-announce.requester-settle-wake.js";
import { restoreSubagentRunsFromDisk } from "../subagents/registry/subagent-registry-persistence.js";
import { saveSubagentRegistryChangesToSqlite } from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "../subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { resetSubagentRegistryForTests } from "../subagents/registry/subagent-registry.test-helpers.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { testing as spawnTesting } from "../subagents/spawn/subagent-spawn.test-support.js";
import { observeSwarmSchedulerWork } from "../subagents/swarm/swarm-scheduler.lifecycle.test-support.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
import {
  consumeSwarmStructuredOutput,
  peekSwarmStructuredOutput,
} from "./structured-output-tool.js";

vi.mock("../../browser-lifecycle-cleanup.js", { spy: true });
vi.mock("../../context-engine/init.js", { spy: true });
vi.mock("../../context-engine/registry.js", { spy: true });
vi.mock("../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));
vi.mock("../timeout.js", { spy: true });
vi.mock("../subagents/announce/subagent-announce.js", { spy: true });
vi.mock("../subagents/announce/subagent-announce.requester-settle-wake.js", { spy: true });
vi.mock("../subagents/registry/subagent-registry-persistence.js", { spy: true });

const config: OpenClawConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  tools: { swarm: true },
  agents: {
    defaults: {
      workspace: os.tmpdir(),
      model: { primary: "openai/gpt-5.4" },
      subagents: { archiveAfterMinutes: 0 },
    },
  },
};
const requester = { agentSessionKey: "agent:main:main", config };

function requestParams({ params }: Parameters<typeof callGateway>[0]): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

async function testContextEngine(): Promise<ContextEngine> {
  return {
    info: { id: "test", name: "Test", version: "0.0.1" },
    ingest: async () => ({ ingested: false }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: false, compacted: false }),
  };
}

const tempDirs = createTempDirTracker();
const completionResolvers = new Map<string, () => void>();
const collectorRunIds = new Set<string>();
let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;

beforeEach(() => {
  schedulerWork = observeSwarmSchedulerWork();
});

afterEach(async () => {
  await schedulerWork.close();
  spawnTesting.setDepsForTest();
  await resetSubagentRegistryForTests({ persist: false });
  for (const runId of collectorRunIds) {
    consumeSwarmStructuredOutput(runId);
  }
  collectorRunIds.clear();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("spawns text and structured collectors with explicit collection guidance and drains them in completion order", async () => {
  await resetSubagentRegistryForTests({ persist: false });
  const settleRootWork = observeRootWork();
  const waitsStarted = createDeferred();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-swarm-tools-"));
  setRuntimeConfigSnapshot(config);
  const publicToGateway = new Map<string, string>();
  const resultTextByRun = new Map<string, string>();
  const modelStructuredCalls: number[] = [];
  const guidance: string[] = [];
  let launchCount = 0;
  async function launchGateway(request: Parameters<typeof callGateway>[0]) {
    if (request.method !== "agent") {
      return {};
    }
    const params = requestParams(request);
    assert(typeof params.extraSystemPrompt === "string", "child system prompt must be text");
    assert(typeof params.message === "string", "child task must be text");
    guidance.push(`${params.extraSystemPrompt}\n${params.message}`);
    const publicRunId = String(params.idempotencyKey);
    const outputSchema = params.swarmOutputSchema as Record<string, unknown>;
    const index = ++launchCount;
    const gatewayRunId = `gateway-${index}`;
    collectorRunIds.add(publicRunId);
    collectorRunIds.add(gatewayRunId);
    const structuredOutput = (
      await createOpenClawToolsAsync({
        agentSessionKey: String(params.sessionKey),
        runId: publicRunId,
        config,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
        swarmCollector: true,
        swarmOutputSchema: outputSchema,
      })
    ).find((tool) => tool.name === "structured_output");
    if (outputSchema) {
      expect(structuredOutput).toBeDefined();
      await structuredOutput?.execute("mock-model-output", { result: { index } });
      modelStructuredCalls.push(index);
    } else {
      expect(structuredOutput).toBeUndefined();
    }
    publicToGateway.set(publicRunId, gatewayRunId);
    resultTextByRun.set(gatewayRunId, `result-${index}`);
    return { runId: gatewayRunId, status: "accepted", acceptedAt: Date.now() };
  }
  spawnTesting.setDepsForTest({
    getGlobalHookRunner: () => null,
    hasInProcessGatewayContext: () => false,
    ensureContextEnginesInitialized: vi.fn(),
    prepareModelChoice: supportedSpawnModelChoice,
    resolveContextEngine: vi.fn(testContextEngine),
  });
  vi.mocked(callGateway).mockImplementation(
    async <T>(request: Parameters<typeof callGateway>[0]) => {
      if (request.method !== "agent.wait") {
        return (await launchGateway(request)) as T;
      }
      const { runId } = requestParams(request);
      assert(typeof runId === "string", "collector wait must identify its run");
      await new Promise<void>((resolve) => {
        completionResolvers.set(runId, resolve);
        if (completionResolvers.size === 3) {
          waitsStarted.resolve();
        }
      });
      const resultText = resultTextByRun.get(runId);
      assert(resultText, "collector run must have a terminal result");
      return {
        status: "ok",
        startedAt: 1,
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: resultText },
      } as T;
    },
  );
  vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockResolvedValue(undefined);
  vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockResolvedValue(false);
  await configureMockSubagentRegistryPersistence({
    persistRegistryRows: saveSubagentRegistryChangesToSqlite,
  });
  vi.mocked(resolveAgentTimeoutMs).mockReturnValue(1_000);
  vi.mocked(restoreSubagentRunsFromDisk).mockResolvedValue(0);
  vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("delivered");
  vi.mocked(ensureContextEnginesInitialized).mockResolvedValue(undefined);
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
  vi.mocked(resolveContextEngine).mockImplementation(testContextEngine);

  const spawn = createSessionsSpawnTool({ ...requester, requesterRunId: "parent-run" });
  const wait = createAgentsWaitTool({ ...requester, agentId: "main" });
  finalizeAgentToolAvailability([spawn, wait]);
  const runIds: string[] = [];
  const outputSchema = {
    type: "object",
    properties: { index: { type: "number" } },
    required: ["index"],
  };
  for (const [offset, expectsCompletionMessage] of [undefined, true, false].entries()) {
    const index = offset + 1;
    const result = await spawn.execute(`spawn-${index}`, {
      task: `worker-${index}`,
      collect: true,
      ...(expectsCompletionMessage === undefined ? {} : { expectsCompletionMessage }),
      ...(index === 2 ? {} : { outputSchema }),
    });
    const details = result.details as { status: string; runId?: string };
    guidance.push(
      result.content.flatMap((block) => (block.type === "text" ? block.text : [])).join("\n"),
    );
    expect(details).toMatchObject({ status: "accepted", expectsCompletionMessage: false });
    expect(details.runId).toBeTruthy();
    runIds.push(details.runId ?? "");
  }
  await waitsStarted.promise;
  // These three collectors start below maxConcurrent and race; only overflow queues FIFO (docs/tools/swarm.md).
  expect(modelStructuredCalls.toSorted((a, b) => a - b)).toEqual([1, 3]);

  const pending = new Set(runIds);
  const completionOrder: string[] = [];
  for (const publicRunId of [runIds[1] ?? "", runIds[2] ?? "", runIds[0] ?? ""]) {
    const gatewayRunId = publicToGateway.get(publicRunId);
    expect(gatewayRunId).toBeTruthy();
    completionResolvers.get(gatewayRunId ?? "")?.();
    const result = await wait.execute("wait", {
      ids: [...pending],
      timeoutSeconds: 30,
    });
    await settleRootWork(true);
    const details = result.details as {
      completed: Array<{ runId: string; result: string; structured?: unknown }>;
    };
    for (const completed of details.completed) {
      const index = runIds.indexOf(completed.runId) + 1;
      expect(completed.result).toBe(`result-${index}`);
      expect(completed.structured).toEqual(index === 2 ? undefined : { index });
      completionOrder.push(completed.runId);
      pending.delete(completed.runId);
    }
  }

  await settleRootWork();
  expect(completionOrder).toEqual([runIds[1], runIds[2], runIds[0]]);
  expect(pending.size).toBe(0);
  expect(captureSubagentCompletionReply).not.toHaveBeenCalled();
  for (const runId of runIds) {
    expect(peekSwarmStructuredOutput(runId)).toBeUndefined();
  }
  // Inspect the real spawn builders, not the mock model's own response.
  for (const note of guidance) {
    expect.soft(note).toMatch(/Collector run: no completion notification/);
    expect.soft(note).not.toMatch(/auto-announce|auto-reported|push-based/);
  }
});
