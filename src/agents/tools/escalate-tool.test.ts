import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeProviderId } from "../model-selection.js";
import { createEscalateTool, resolveEscalationModel } from "./escalate-tool.js";

describe("createEscalateTool", () => {
  it("invokes onEscalate callback with reason", async () => {
    let captured: string | undefined;
    const tool = createEscalateTool({
      onEscalate: (reason) => {
        captured = reason;
      },
    });

    expect(tool.name).toBe("escalate");
    await tool.execute("call-1", { reason: "complex reasoning needed" });
    expect(captured).toBe("complex reasoning needed");
  });

  it("returns a JSON result indicating escalation", async () => {
    const tool = createEscalateTool({ onEscalate: () => {} });
    const result = await tool.execute("call-2", { reason: "needs deeper analysis" });
    expect(result).toBeDefined();
  });

  it("last call wins when called multiple times", async () => {
    let captured: string | undefined;
    const tool = createEscalateTool({
      onEscalate: (reason) => {
        captured = reason;
      },
    });

    await tool.execute("call-1", { reason: "first" });
    await tool.execute("call-2", { reason: "second" });
    expect(captured).toBe("second");
  });
});

describe("resolveEscalationModel", () => {
  it("parses a valid provider/model ref", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toEqual({
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

  it("returns undefined for invalid refs", () => {
    const cases = ["no-slash-model", "/model-only", "", "   ", "bedrock/"];
    for (const ref of cases) {
      const cfg = {
        agents: { defaults: { model: { escalation: ref } } },
      } as OpenClawConfig;
      expect(resolveEscalationModel(cfg)).toBeUndefined();
    }
  });

  it("trims whitespace and normalizes provider", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "  bedrock/claude-opus-4-6  " } } },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toEqual({
      provider: "amazon-bedrock",
      model: "claude-opus-4-6",
      ref: "amazon-bedrock/claude-opus-4-6",
    });
  });

  it("handles refs with multiple slashes", () => {
    const cfg = {
      agents: {
        defaults: { model: { escalation: "bedrock/eu.anthropic.claude-opus-4-6" } },
      },
    } as OpenClawConfig;

    expect(resolveEscalationModel(cfg)).toEqual({
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

    expect(resolveEscalationModel(cfg, "my-agent")).toEqual({
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

    expect(resolveEscalationModel(cfg, "my-agent")).toEqual({
      provider: "amazon-bedrock",
      model: "claude-opus-4-6",
      ref: "amazon-bedrock/claude-opus-4-6",
    });
  });
});

describe("escalation identity check", () => {
  const isEscalationTarget = (provider: string, modelId: string, escalationRef: string) =>
    `${normalizeProviderId(provider)}/${modelId}` === escalationRef;

  it("matches when current model is the escalation target", () => {
    const ref = resolveEscalationModel({
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig)!;
    expect(isEscalationTarget("amazon-bedrock", "claude-opus-4-6", ref.ref)).toBe(true);
  });

  it("matches when provider alias normalizes", () => {
    const ref = resolveEscalationModel({
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig)!;
    expect(isEscalationTarget("bedrock", "claude-opus-4-6", ref.ref)).toBe(true);
  });

  it("does not match when model differs", () => {
    const ref = resolveEscalationModel({
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig)!;
    expect(isEscalationTarget("amazon-bedrock", "claude-haiku-4-5", ref.ref)).toBe(false);
  });
});
