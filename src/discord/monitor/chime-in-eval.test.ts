import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockComplete, mockFind, mockSetRuntimeApiKey } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockFind: vi.fn(),
  mockSetRuntimeApiKey: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: mockComplete,
}));

vi.mock("../../agents/pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({
    setRuntimeApiKey: mockSetRuntimeApiKey,
  })),
  discoverModels: vi.fn(() => ({
    find: mockFind,
  })),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({ apiKey: "test-key" })),
  requireApiKey: vi.fn(() => "test-key"),
}));

vi.mock("../../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/test-agent"),
  resolveAgentModelPrimary: vi.fn(() => "anthropic/claude-haiku"),
}));

vi.mock("../../agents/model-selection.js", () => ({
  normalizeProviderId: vi.fn((p: string) => p.toLowerCase()),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { ChimeInConfig } from "../../config/types.discord.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { evaluateChimeIn } from "./chime-in-eval.js";

function makeAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function makeHistory(entries: Array<{ sender: string; body: string }>): HistoryEntry[] {
  return entries.map((e) => ({
    sender: e.sender,
    body: e.body,
    timestamp: Date.now(),
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
  }));
}

const baseChimeInConfig: ChimeInConfig = { every: 5 };
const baseCfg = {} as OpenClawConfig;

function callEvaluate(overrides?: { history?: HistoryEntry[]; chimeInConfig?: ChimeInConfig }) {
  return evaluateChimeIn({
    history: overrides?.history ?? makeHistory([{ sender: "Alice", body: "Hello" }]),
    chimeInConfig: overrides?.chimeInConfig ?? baseChimeInConfig,
    cfg: baseCfg,
    agentId: "main",
    channelId: "ch-1",
  });
}

describe("evaluateChimeIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockReturnValue({
      provider: "anthropic",
      id: "claude-haiku",
      input: ["text"],
    });
  });

  it("returns true when model says YES", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("YES"));
    const result = await callEvaluate();
    expect(result).toBe(true);
  });

  it("returns true when model says YES with trailing text", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("YES, I should respond."));
    const result = await callEvaluate();
    expect(result).toBe(true);
  });

  it("returns false when model says NO", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("NO"));
    const result = await callEvaluate();
    expect(result).toBe(false);
  });

  it("returns false on empty history", async () => {
    const result = await callEvaluate({ history: [] });
    expect(result).toBe(false);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("returns false when all history entries are whitespace-only", async () => {
    const history = makeHistory([{ sender: "Alice", body: "   " }]);
    mockComplete.mockResolvedValue(makeAssistantMessage("YES"));
    const result = await callEvaluate({ history });
    expect(result).toBe(true);
  });

  it("uses custom prompt when configured", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("NO"));
    const customConfig: ChimeInConfig = { every: 3, prompt: "Custom evaluation prompt" };
    await callEvaluate({ chimeInConfig: customConfig });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const context = mockComplete.mock.calls[0][1];
    const userMessage = context.messages[0].content[0].text;
    expect(userMessage).toContain("Custom evaluation prompt");
  });

  it("uses default prompt when prompt is not configured", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("NO"));
    await callEvaluate();

    const context = mockComplete.mock.calls[0][1];
    const userMessage = context.messages[0].content[0].text;
    expect(userMessage).toContain("monitoring a group chat");
  });

  it("includes history text in the prompt", async () => {
    const history = makeHistory([
      { sender: "Bob", body: "What time is it?" },
      { sender: "Carol", body: "I need help with coding" },
    ]);
    mockComplete.mockResolvedValue(makeAssistantMessage("YES"));
    await callEvaluate({ history });

    const context = mockComplete.mock.calls[0][1];
    const userMessage = context.messages[0].content[0].text;
    expect(userMessage).toContain("Bob: What time is it?");
    expect(userMessage).toContain("Carol: I need help with coding");
  });

  it("uses custom model when configured", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("NO"));
    const customConfig: ChimeInConfig = {
      every: 5,
      model: "openai/gpt-4o-mini",
    };
    await callEvaluate({ chimeInConfig: customConfig });

    expect(mockFind).toHaveBeenCalledWith("openai", "gpt-4o-mini");
  });

  it("falls back to agent model when chimeIn.model is undefined", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("NO"));
    await callEvaluate({ chimeInConfig: { every: 5 } });

    expect(mockFind).toHaveBeenCalledWith("anthropic", "claude-haiku");
  });

  it("returns false on API error", async () => {
    mockComplete.mockRejectedValue(new Error("API rate limit"));
    const result = await callEvaluate();
    expect(result).toBe(false);
  });

  it("returns false when model is not found", async () => {
    mockFind.mockReturnValue(null);
    const result = await callEvaluate();
    expect(result).toBe(false);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("passes maxTokens: 10 to complete", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("YES"));
    await callEvaluate();

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const options = mockComplete.mock.calls[0][2];
    expect(options.maxTokens).toBe(10);
  });

  it("treats lowercase 'yes' as affirmative", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("yes"));
    const result = await callEvaluate();
    expect(result).toBe(true);
  });

  it("treats 'NOPE' as negative (does not start with YES)", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("NOPE"));
    const result = await callEvaluate();
    expect(result).toBe(false);
  });

  it("falls back to agent default when model ref has no slash", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("YES"));
    await callEvaluate({ chimeInConfig: { every: 5, model: "openai" } });
    expect(mockFind).toHaveBeenCalledWith("anthropic", "claude-haiku");
  });

  it("falls back to agent default when model ref ends with slash", async () => {
    mockComplete.mockResolvedValue(makeAssistantMessage("YES"));
    await callEvaluate({ chimeInConfig: { every: 5, model: "openai/" } });
    expect(mockFind).toHaveBeenCalledWith("anthropic", "claude-haiku");
  });
});
