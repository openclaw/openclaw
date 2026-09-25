import "../subagents/registry/subagent-registry.mocks.shared.js";
import assert from "node:assert/strict";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { callGateway } from "../../gateway/call.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { loadAgentRuntimePluginRegistryHandle } from "../runtime-plugins.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../subagents/announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../subagents/announce/subagent-announce.requester-settle-wake.js";
import {
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "../subagents/registry/subagent-registry-state.js";
import { resetSubagentRegistryForTests } from "../subagents/registry/subagent-registry.test-helpers.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { testing as spawnTesting } from "../subagents/spawn/subagent-spawn.test-support.js";
import { testing as swarmSchedulerTesting } from "../subagents/swarm/swarm-scheduler.test-support.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";
import { createSessionsSpawnTool } from "./sessions-spawn-tool.js";
import {
  consumeSwarmStructuredOutput,
  peekSwarmStructuredOutput,
} from "./structured-output-tool.js";

vi.mock("../../browser-lifecycle-cleanup.js", { spy: true });
vi.mock("../../config/config.js", { spy: true });
vi.mock("../../context-engine/init.js", { spy: true });
vi.mock("../../context-engine/registry.js", { spy: true });
vi.mock("../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));
vi.mock("../timeout.js", { spy: true });
vi.mock("../subagents/announce/subagent-announce.js", { spy: true });
vi.mock("../subagents/announce/subagent-announce.requester-settle-wake.js", { spy: true });
vi.mock("../subagents/registry/subagent-registry-state.js", { spy: true });

const requesterSessionKey = "agent:main:main";
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

function requestParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const params = (value as { params?: unknown }).params;
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

describe("swarm tools integration", () => {
  const tempDirs = createTempDirTracker();
  const completionResolvers = new Map<string, () => void>();
  const collectorRunIds = new Set<string>();

  beforeEach(() => {
    completionResolvers.clear();
    resetSubagentRegistryForTests({ persist: false });
    swarmSchedulerTesting.reset();
  });

  afterEach(async () => {
    spawnTesting.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    for (const runId of collectorRunIds) {
      consumeSwarmStructuredOutput(runId);
    }
    collectorRunIds.clear();
    swarmSchedulerTesting.reset();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    tempDirs.cleanup();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("spawns text and structured collectors with explicit collection guidance and drains them in completion order", async () => {
    const stateDir = tempDirs.make("openclaw-swarm-tools-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const publicToGateway = new Map<string, string>();
    const resultTextBySession = new Map<string, string>();
    const modelStructuredCalls: number[] = [];
    const childGuidance: string[] = [];
    const acceptedNotes: string[] = [];
    let launchCount = 0;
    const launchGateway = vi.fn(async (request: unknown) => {
      const method =
        request && typeof request === "object"
          ? (request as { method?: unknown }).method
          : undefined;
      if (method !== "agent") {
        return {};
      }
      const params = requestParams(request);
      assert(typeof params.extraSystemPrompt === "string", "child system prompt must be text");
      assert(typeof params.message === "string", "child task must be text");
      childGuidance.push(`${params.extraSystemPrompt}\n${params.message}`);
      const publicRunId = String(params.idempotencyKey);
      const childSessionKey = String(params.sessionKey);
      const outputSchema = params.swarmOutputSchema as Record<string, unknown>;
      const index = ++launchCount;
      const gatewayRunId = `gateway-${index}`;
      collectorRunIds.add(publicRunId);
      collectorRunIds.add(gatewayRunId);
      const structuredOutput = createOpenClawTools({
        agentSessionKey: childSessionKey,
        runId: publicRunId,
        config,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
        swarmCollector: true,
        swarmOutputSchema: outputSchema,
      }).find((tool) => tool.name === "structured_output");
      if (outputSchema) {
        expect(structuredOutput).toBeDefined();
        await structuredOutput?.execute("mock-model-output", { result: { index } });
        modelStructuredCalls.push(index);
      } else {
        expect(structuredOutput).toBeUndefined();
      }
      publicToGateway.set(publicRunId, gatewayRunId);
      resultTextBySession.set(childSessionKey, `result-${index}`);
      return { runId: gatewayRunId, status: "accepted", acceptedAt: Date.now() };
    });
    spawnTesting.setDepsForTest({
      getGlobalHookRunner: () => null,
      getRuntimeConfig: () => config,
      hasInProcessGatewayContext: () => false,
      ensureContextEnginesInitialized: vi.fn(),
      prepareModelChoice: supportedSpawnModelChoice,
      resolveContextEngine: vi.fn(async () => ({
        info: { id: "test", name: "Test", version: "0.0.1" },
        ingest: vi.fn(async () => ({ ingested: false })),
        assemble: vi.fn(async ({ messages }: { messages: unknown[] }) => ({
          messages,
          estimatedTokens: 0,
        })),
        compact: vi.fn(async () => ({ ok: false, compacted: false })),
      })) as never,
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
        });
        return { status: "ok", startedAt: 1, endedAt: Date.now() } as T;
      },
    );
    vi.mocked(captureSubagentCompletionReply).mockImplementation(async (sessionKey) => {
      return resultTextBySession.get(sessionKey) ?? "";
    });
    vi.mocked(cleanupBrowserSessionsForLifecycleEnd).mockResolvedValue(undefined);
    vi.mocked(getRuntimeConfig).mockReturnValue(config);
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockResolvedValue(false);
    vi.mocked(persistSubagentRunsToDisk).mockImplementation(() => {});
    vi.mocked(persistSubagentRunsToDiskOrThrow).mockImplementation(() => {});
    vi.mocked(resolveAgentTimeoutMs).mockReturnValue(1_000);
    vi.mocked(restoreSubagentRunsFromDisk).mockReturnValue(0);
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("delivered");
    vi.mocked(ensureContextEnginesInitialized).mockImplementation(() => {});
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
    vi.mocked(resolveContextEngine).mockImplementation(async () => ({
      info: { id: "test", name: "Test", version: "0.0.1" },
      ingest: vi.fn(async () => ({ ingested: false })),
      assemble: vi.fn<ContextEngine["assemble"]>(async ({ messages }) => ({
        messages,
        estimatedTokens: 0,
      })),
      compact: vi.fn(async () => ({ ok: false, compacted: false })),
    }));

    const spawn = createSessionsSpawnTool({
      agentSessionKey: requesterSessionKey,
      requesterRunId: "parent-run",
      config,
    });
    const wait = createAgentsWaitTool({
      agentSessionKey: requesterSessionKey,
      agentId: "main",
      config,
    });
    finalizeAgentToolAvailability([spawn, wait]);
    const runIds: string[] = [];
    const completionInputs = [
      {},
      { expectsCompletionMessage: true },
      { expectsCompletionMessage: false },
    ];
    for (const [offset, completion] of completionInputs.entries()) {
      const index = offset + 1;
      const result = await spawn.execute(`spawn-${index}`, {
        task: `worker-${index}`,
        collect: true,
        ...completion,
        ...(index === 2
          ? {}
          : {
              outputSchema: {
                type: "object",
                properties: { index: { type: "number" } },
                required: ["index"],
              },
            }),
      });
      const details = result.details as { status: string; runId?: string };
      acceptedNotes.push(
        result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      );
      expect(details).toMatchObject({ status: "accepted", expectsCompletionMessage: false });
      expect(details.runId).toBeTruthy();
      runIds.push(details.runId ?? "");
    }
    await vi.waitFor(() => expect(completionResolvers.size).toBe(3));
    expect(modelStructuredCalls).toEqual([1, 3]);

    const pending = new Set(runIds);
    const completionOrder: string[] = [];
    for (const publicRunId of [runIds[1] ?? "", runIds[2] ?? "", runIds[0] ?? ""]) {
      const gatewayRunId = publicToGateway.get(publicRunId);
      expect(gatewayRunId).toBeTruthy();
      completionResolvers.get(gatewayRunId ?? "")?.();
      const result = await wait.execute("wait", {
        ids: [...pending],
        timeoutSeconds: 1,
      });
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

    expect(completionOrder).toEqual([runIds[1], runIds[2], runIds[0]]);
    expect(pending.size).toBe(0);
    for (const runId of runIds) {
      expect(peekSwarmStructuredOutput(runId)).toBeUndefined();
    }
    // Inspect the real spawn builders, not the mock model's own response.
    for (const guidance of [...childGuidance, ...acceptedNotes]) {
      expect.soft(guidance).toMatch(/Collector run: no completion notification/);
      expect.soft(guidance).not.toMatch(/auto-announce|auto-reported|push-based/);
    }
  });
});
