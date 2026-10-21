import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAttemptReplayMetadata } from "../embedded-agent-runner/run/attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { configForProviders } from "../model-auth.fixtures.test-support.js";
import { model as catalogModel } from "../model-catalog-fixtures.test-support.js";
import { makeAgentAssistantMessage } from "./agent-message-fixtures.js";
import { createZeroUsageFixture } from "./usage-fixtures.js";

export type EmbeddedAgentRunnerTestWorkspace = Awaited<
  ReturnType<typeof createEmbeddedAgentRunnerTestWorkspace>
>;

export async function createEmbeddedAgentRunnerTestWorkspace(prefix: string) {
  // openclaw-temp-dir: allow suite-owned workspace drains agent databases before removal
  const tempRoot = await fs.mkdtemp(path.join(realpathSync.native(os.tmpdir()), prefix));
  const agentDir = path.join(tempRoot, "agent");
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { tempRoot, agentDir, workspaceDir };
}

export async function cleanupEmbeddedAgentRunnerTestWorkspace(
  workspace: EmbeddedAgentRunnerTestWorkspace | undefined,
): Promise<void> {
  if (!workspace) {
    return;
  }
  // Join SQLite owners before removing their files without eagerly loading the runtime.
  const { closeOpenClawAgentDatabasesAsync } =
    await import("../../state/openclaw-agent-db-lifecycle.js");
  await closeOpenClawAgentDatabasesAsync(workspace.tempRoot);
  await fs.rm(workspace.tempRoot, { recursive: true, force: true });
}

function mockModel(id: string, name: string) {
  return { ...catalogModel(id, name), contextWindow: 16_000, maxTokens: 2048 };
}

export function createEmbeddedAgentRunnerOpenAiConfig(modelIds: string[]): OpenClawConfig {
  return {
    agents: { entries: { main: {}, test: {}, "embedded-agent": {} } },
    ...configForProviders({
      openai: {
        api: "openai-responses",
        apiKey: "sk-test",
        baseUrl: "https://example.com",
        models: modelIds.map((id) => mockModel(id, `Mock ${id}`)),
      },
    }),
  };
}

export async function immediateEnqueue<T>(task: () => Promise<T>): Promise<T> {
  return await task();
}

export function createMockUsage(input: number, output: number) {
  return {
    ...createZeroUsageFixture(),
    input,
    output,
    totalTokens: input + output,
  };
}

const baseUsage = createMockUsage(0, 0);

export function buildEmbeddedRunnerAssistant(
  overrides: Partial<AssistantMessage>,
): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [],
    model: "mock-1",
    usage: baseUsage,
    timestamp: Date.now(),
    ...overrides,
  });
}

export function makeEmbeddedRunnerAttempt(
  overrides: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
  const evidence = {
    toolMetas: overrides.toolMetas ?? [],
    didSendViaMessagingTool: overrides.didSendViaMessagingTool ?? false,
    messagingToolSentTexts: overrides.messagingToolSentTexts ?? [],
    messagingToolSentMediaUrls: overrides.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: overrides.messagingToolSentTargets ?? [],
  };
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session:test",
    systemPromptReport: undefined,
    messagesSnapshot: [],
    assistantTexts: [],
    lastAssistant: undefined,
    // Explicit undefined overrides still represent an attempt that produced no response.
    currentAttemptAssistant: overrides.lastAssistant,
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({ ...evidence, successfulCronAdds: overrides.successfulCronAdds }),
    ...evidence,
    cloudCodeAssistFormatError: false,
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

export function createResolvedEmbeddedRunnerModel(
  provider: string,
  modelId: string,
  options?: { baseUrl?: string },
) {
  return {
    logicalRef: { provider, model: modelId },
    model: {
      ...mockModel(modelId, modelId),
      api: "openai-responses",
      provider,
      baseUrl: options?.baseUrl ?? `https://example.com/${provider}`,
    },
    error: undefined,
    authStorage: { setRuntimeApiKey: () => undefined },
    modelRegistry: {},
  };
}
