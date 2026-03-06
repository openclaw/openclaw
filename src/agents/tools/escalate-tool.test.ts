import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEscalateTool, pendingEscalations, resolveEscalationModel } from "./escalate-tool.js";

afterEach(() => {
  pendingEscalations.clear();
});

describe("createEscalateTool", () => {
  it("sets pendingEscalations entry without aborting", async () => {
    const tool = createEscalateTool({
      sessionKey: "test-session",
    });

    expect(tool.name).toBe("escalate");

    await tool.execute("call-1", { reason: "complex reasoning needed" });

    expect(pendingEscalations.has("test-session")).toBe(true);
    expect(pendingEscalations.get("test-session")?.reason).toBe("complex reasoning needed");
  });

  it("returns a JSON result indicating escalation", async () => {
    const tool = createEscalateTool({
      sessionKey: "s1",
    });

    const result = await tool.execute("call-2", { reason: "needs deeper analysis" });
    expect(result).toBeDefined();
  });
});

describe("resolveEscalationModel", () => {
  it("parses a valid provider/model ref", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig;

    const result = resolveEscalationModel(cfg);
    expect(result).toEqual({
      provider: "amazon-bedrock",
      model: "claude-opus-4-6",
      ref: "amazon-bedrock/claude-opus-4-6",
    });
  });

  it("returns undefined when config is undefined", () => {
    expect(resolveEscalationModel(undefined)).toBeUndefined();
  });

  it("returns undefined when model config is a string", () => {
    const cfg = {
      agents: { defaults: { model: "bedrock/claude-haiku" } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toBeUndefined();
  });

  it("returns undefined when escalation field is missing", () => {
    const cfg = {
      agents: { defaults: { model: { primary: "bedrock/claude-haiku" } } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toBeUndefined();
  });

  it("returns undefined when escalation ref has no slash", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "no-slash-model" } } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toBeUndefined();
  });

  it("returns undefined when escalation ref starts with slash", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "/model-only" } } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toBeUndefined();
  });

  it("returns undefined for empty or whitespace ref", () => {
    expect(
      resolveEscalationModel({
        agents: { defaults: { model: { escalation: "" } } },
      } as OpenClawConfig),
    ).toBeUndefined();

    expect(
      resolveEscalationModel({
        agents: { defaults: { model: { escalation: "   " } } },
      } as OpenClawConfig),
    ).toBeUndefined();
  });

  it("returns undefined when model segment is empty (trailing slash)", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "bedrock/" } } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toBeUndefined();
  });

  it("trims whitespace and normalizes provider", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "  bedrock/claude-opus-4-6  " } } },
    } as OpenClawConfig;

    const result = resolveEscalationModel(cfg);
    expect(result).toEqual({
      provider: "amazon-bedrock",
      model: "claude-opus-4-6",
      ref: "amazon-bedrock/claude-opus-4-6",
    });
  });

  it("handles refs with multiple slashes (model id contains slash)", () => {
    const cfg = {
      agents: {
        defaults: { model: { escalation: "bedrock/eu.anthropic.claude-opus-4-6" } },
      },
    } as OpenClawConfig;

    const result = resolveEscalationModel(cfg);
    expect(result).toEqual({
      provider: "amazon-bedrock",
      model: "eu.anthropic.claude-opus-4-6",
      ref: "amazon-bedrock/eu.anthropic.claude-opus-4-6",
    });
  });

  it("prefers per-agent escalation over global default", () => {
    const cfg = {
      agents: {
        defaults: { model: { escalation: "bedrock/claude-opus-4-6" } },
        list: [{ id: "my-agent", model: { escalation: "openai/gpt-4o" } }],
      },
    } as OpenClawConfig;

    const result = resolveEscalationModel(cfg, "my-agent");
    expect(result).toEqual({
      provider: "openai",
      model: "gpt-4o",
      ref: "openai/gpt-4o",
    });
  });

  it("falls back to global default when agent has no escalation", () => {
    const cfg = {
      agents: {
        defaults: { model: { escalation: "bedrock/claude-opus-4-6" } },
        list: [{ id: "my-agent", model: { primary: "openai/gpt-4o-mini" } }],
      },
    } as OpenClawConfig;

    const result = resolveEscalationModel(cfg, "my-agent");
    expect(result).toEqual({
      provider: "amazon-bedrock",
      model: "claude-opus-4-6",
      ref: "amazon-bedrock/claude-opus-4-6",
    });
  });

  it("falls back to global default when agentId is not in config", () => {
    const cfg = {
      agents: {
        defaults: { model: { escalation: "bedrock/claude-opus-4-6" } },
      },
    } as OpenClawConfig;

    const result = resolveEscalationModel(cfg, "nonexistent-agent");
    expect(result).toEqual({
      provider: "amazon-bedrock",
      model: "claude-opus-4-6",
      ref: "amazon-bedrock/claude-opus-4-6",
    });
  });
});
