import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.hoisted(() => vi.fn());
const getApiKeyForModel = vi.hoisted(() => vi.fn());
const requireApiKey = vi.hoisted(() => vi.fn());
const resolveDefaultModelForAgent = vi.hoisted(() => vi.fn());
const resolveModelAsync = vi.hoisted(() => vi.fn());
const prepareModelForSimpleCompletion = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    completeSimple,
  };
});

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel,
  requireApiKey,
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent,
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync,
}));

vi.mock("../../agents/simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion,
}));

import { generateTopicLabel, resolveAutoTopicLabelConfig } from "./auto-topic-label.js";

describe("resolveAutoTopicLabelConfig", () => {
  const DEFAULT_PROMPT_SUBSTRING = "Generate a very short topic label";

  it("returns enabled with default prompt when both configs are undefined", () => {
    const result = resolveAutoTopicLabelConfig(undefined, undefined);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("returns enabled with default prompt when config is true (boolean shorthand)", () => {
    const result = resolveAutoTopicLabelConfig(true, undefined);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("returns null when config is false", () => {
    const result = resolveAutoTopicLabelConfig(false, undefined);
    expect(result).toBeNull();
  });

  it("returns enabled with custom prompt (object form)", () => {
    const result = resolveAutoTopicLabelConfig(
      { enabled: true, prompt: "Custom prompt" },
      undefined,
    );
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toBe("Custom prompt");
  });

  it("returns null when object form has enabled: false", () => {
    const result = resolveAutoTopicLabelConfig({ enabled: false }, undefined);
    expect(result).toBeNull();
  });

  it("returns default prompt when object form has no prompt", () => {
    const result = resolveAutoTopicLabelConfig({ enabled: true }, undefined);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("returns default prompt when object form has empty prompt", () => {
    const result = resolveAutoTopicLabelConfig({ enabled: true, prompt: "  " }, undefined);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain(DEFAULT_PROMPT_SUBSTRING);
  });

  it("per-DM config takes priority over account config", () => {
    const result = resolveAutoTopicLabelConfig(false, true);
    expect(result).toBeNull();
  });

  it("falls back to account config when direct config is undefined", () => {
    const result = resolveAutoTopicLabelConfig(undefined, {
      enabled: true,
      prompt: "Account prompt",
    });
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("Account prompt");
  });

  it("per-DM disabled overrides account enabled", () => {
    const result = resolveAutoTopicLabelConfig(false, { enabled: true, prompt: "Account prompt" });
    expect(result).toBeNull();
  });

  it("per-DM custom prompt overrides account prompt", () => {
    const result = resolveAutoTopicLabelConfig(
      { prompt: "DM prompt" },
      { prompt: "Account prompt" },
    );
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("DM prompt");
  });

  it("object form without enabled field defaults to enabled", () => {
    const result = resolveAutoTopicLabelConfig({ prompt: "Test" }, undefined);
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.prompt).toBe("Test");
  });
});

describe("generateTopicLabel", () => {
  beforeEach(() => {
    completeSimple.mockReset();
    getApiKeyForModel.mockReset();
    requireApiKey.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveModelAsync.mockReset();
    prepareModelForSimpleCompletion.mockReset();

    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-test" });
    resolveModelAsync.mockResolvedValue({
      model: { provider: "openai" },
      authStorage: {},
      modelRegistry: {},
    });
    prepareModelForSimpleCompletion.mockImplementation(({ model }) => model);
    getApiKeyForModel.mockResolvedValue({ apiKey: "resolved-key", mode: "api-key" });
    requireApiKey.mockReturnValue("resolved-key");
    completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "Topic label" }],
    });
  });

  it("uses routed agentDir for model and auth resolution", async () => {
    await generateTopicLabel({
      userMessage: "Need help with invoices",
      prompt: "prompt",
      cfg: {},
      agentId: "billing",
      agentDir: "/tmp/agents/billing/agent",
    });

    expect(resolveDefaultModelForAgent).toHaveBeenCalledWith({
      cfg: {},
      agentId: "billing",
    });
    expect(resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "gpt-test",
      "/tmp/agents/billing/agent",
      {},
    );
    expect(getApiKeyForModel).toHaveBeenCalledWith({
      model: { provider: "openai" },
      cfg: {},
      agentDir: "/tmp/agents/billing/agent",
    });
    expect(prepareModelForSimpleCompletion).toHaveBeenCalledWith({
      model: { provider: "openai" },
      cfg: {},
    });
  });
});
