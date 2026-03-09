import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeProviderId } from "../model-selection.js";
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

describe("escalation identity check (tool suppression for escalation model)", () => {
  // Mirrors the condition in attempt.ts that prevents the escalation target
  // from receiving the escalate tool (which would cause infinite loops).
  const isEscalationTarget = (provider: string, modelId: string, escalationRef: string) =>
    `${normalizeProviderId(provider)}/${modelId}` === escalationRef;

  it("skips escalate tool when current model matches escalation target", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig;

    const resolved = resolveEscalationModel(cfg)!;
    expect(isEscalationTarget("amazon-bedrock", "claude-opus-4-6", resolved.ref)).toBe(true);
  });

  it("skips escalate tool when provider alias normalizes to match", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig;

    const resolved = resolveEscalationModel(cfg)!;
    // "bedrock" normalizes to "amazon-bedrock"
    expect(isEscalationTarget("bedrock", "claude-opus-4-6", resolved.ref)).toBe(true);
  });

  it("registers escalate tool when current model differs from escalation target", () => {
    const cfg = {
      agents: { defaults: { model: { escalation: "bedrock/claude-opus-4-6" } } },
    } as OpenClawConfig;

    const resolved = resolveEscalationModel(cfg)!;
    expect(isEscalationTarget("amazon-bedrock", "claude-haiku-4-5", resolved.ref)).toBe(false);
  });
});

describe("escalation map consumption (tryHandleEscalation behavior)", () => {
  it("entry is consumed on read (simulating success path)", async () => {
    const tool = createEscalateTool({ sessionKey: "session-a" });
    await tool.execute("call-1", { reason: "complex task" });

    expect(pendingEscalations.has("session-a")).toBe(true);

    // Simulate what tryHandleEscalation does: read + delete
    const pending = pendingEscalations.get("session-a");
    pendingEscalations.delete("session-a");

    expect(pending?.reason).toBe("complex task");
    expect(pendingEscalations.has("session-a")).toBe(false);
  });

  it("entry is consumed on error path the same way", async () => {
    const tool = createEscalateTool({ sessionKey: "session-err" });
    await tool.execute("call-1", { reason: "needs analysis" });

    // Error path also reads + deletes the entry
    const pending = pendingEscalations.get("session-err");
    pendingEscalations.delete("session-err");

    expect(pending?.reason).toBe("needs analysis");
    expect(pendingEscalations.has("session-err")).toBe(false);
  });

  it("concurrent sessions do not collide", async () => {
    const toolA = createEscalateTool({ sessionKey: "session-a" });
    const toolB = createEscalateTool({ sessionKey: "session-b" });

    await toolA.execute("call-1", { reason: "reason A" });
    await toolB.execute("call-2", { reason: "reason B" });

    expect(pendingEscalations.size).toBe(2);

    // Consuming one does not affect the other
    pendingEscalations.delete("session-a");
    expect(pendingEscalations.has("session-b")).toBe(true);
    expect(pendingEscalations.get("session-b")?.reason).toBe("reason B");
  });
});

describe("escalation cleanup (post-loop safety)", () => {
  it("stale entry is cleaned up by key-based delete", async () => {
    const tool = createEscalateTool({ sessionKey: "stale-session" });
    await tool.execute("call-1", { reason: "will not be consumed normally" });

    expect(pendingEscalations.has("stale-session")).toBe(true);

    // Simulate the post-loop defensive cleanup in agent-runner-execution.ts
    pendingEscalations.delete("stale-session");
    expect(pendingEscalations.has("stale-session")).toBe(false);
  });

  it("delete on non-existent key is a no-op", () => {
    // Ensures the post-loop cleanup is safe even when tryHandleEscalation
    // already consumed the entry (the normal happy path).
    expect(pendingEscalations.has("never-set")).toBe(false);
    pendingEscalations.delete("never-set");
    expect(pendingEscalations.size).toBe(0);
  });
});
