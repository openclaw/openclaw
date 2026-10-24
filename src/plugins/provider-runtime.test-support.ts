import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi, type Mock } from "vitest";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { AnyAgentTool } from "./types.js";

type ProviderRuntime = typeof import("./provider-runtime.js");
export const PROVIDER_RUNTIME_TEST_MODEL: ProviderRuntimeModel & {
  headers?: Record<string, string>;
} = {
  id: "demo-model",
  name: "Demo Model",
  api: "openai-responses",
  provider: "demo",
  baseUrl: "https://api.example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

export const DEMO_SANITIZED_MESSAGE: AgentMessage = {
  role: "assistant",
  content: [{ type: "text", text: "sanitized" }],
  api: PROVIDER_RUNTIME_TEST_MODEL.api,
  provider: PROVIDER_RUNTIME_TEST_MODEL.provider,
  model: PROVIDER_RUNTIME_TEST_MODEL.id,
  usage: createZeroUsageFixture(),
  stopReason: "stop",
  timestamp: 2,
};

export const DEMO_TOOL = {
  name: "demo-tool",
  label: "Demo tool",
  description: "Demo tool",
  parameters: { type: "object", properties: {} },
  execute: vi.fn(async () => ({ content: [], details: undefined })),
} as unknown as AnyAgentTool;

const openaiCodexCatalogEntries = [
  { provider: "openai", id: "gpt-5.5", name: "gpt-5.5" },
  { provider: "openai", id: "gpt-5.5-pro", name: "gpt-5.5-pro" },
  { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
  { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
  { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
  { provider: "openai", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
];

const expectedAugmentedOpenaiCodexCatalogEntries = [
  { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
  { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
  { provider: "openai", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
  { provider: "openai", id: "gpt-5.4-nano", name: "gpt-5.4-nano" },
];

export const expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55 = [
  { provider: "openai", id: "gpt-5.5-pro", name: "gpt-5.5-pro" },
  ...expectedAugmentedOpenaiCodexCatalogEntries,
];

export const expectedOpenaiPluginCodexCatalogEntriesWithGpt55 =
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55;

export function expectCodexMissingAuthHint(
  buildMessage: ProviderRuntime["buildProviderMissingAuthMessageWithPlugin"],
  expectedModel = "openai/gpt-5.5",
) {
  const context = {
    env: process.env,
    provider: "openai",
    listProfileIds: (providerId: string) => (providerId === "openai" ? ["p1"] : []),
  };
  expect(buildMessage({ provider: "openai", env: process.env, context })).toContain(expectedModel);
}

export async function expectAugmentedCodexCatalog(
  augmentCatalog: ProviderRuntime["augmentModelCatalogWithProviderPlugins"],
  expectedEntries = expectedAugmentedOpenaiCodexCatalogEntries,
) {
  const env = process.env;
  const result = await augmentCatalog({
    env,
    context: { env, entries: openaiCodexCatalogEntries },
  });
  expect(result).toHaveLength(expectedEntries.length);
  for (const entry of expectedEntries) {
    expect(result).toContainEqual(expect.objectContaining(entry));
  }
}

type ProviderRuntimeLogger = Pick<SubsystemLogger, "isEnabled"> & {
  [Method in "debug" | "info" | "warn" | "error"]: Mock<SubsystemLogger[Method]>;
};

export function createProviderRuntimeLogger(
  warn: ProviderRuntimeLogger["warn"],
): ProviderRuntimeLogger {
  return {
    isEnabled: () => false,
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
}
