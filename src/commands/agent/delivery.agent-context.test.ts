import { describe, expect, it } from "vitest";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import { buildAgentContextFromMeta } from "./delivery.js";

type RunResult = Parameters<typeof buildAgentContextFromMeta>[0];

function makeResult(overrides?: {
  toolMetas?: Array<{ toolName: string; meta?: string }>;
  usage?: { input?: number; output?: number; total?: number };
  lastCallUsage?: { input?: number; output?: number; total?: number };
  contextWindow?: number;
}): RunResult {
  return {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 100,
      toolMetas: overrides?.toolMetas ?? [],
      agentMeta: {
        sessionId: "test-session",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: overrides?.usage,
        lastCallUsage: overrides?.lastCallUsage,
        contextWindow: overrides?.contextWindow,
      },
    },
  };
}

const session: OutboundSessionContext = {
  key: "agent:main:test",
  agentId: "main",
} as OutboundSessionContext;

describe("buildAgentContextFromMeta", () => {
  it("returns undefined when meta is missing", () => {
    const result = { payloads: [], meta: undefined } as unknown as RunResult;
    expect(buildAgentContextFromMeta(result, session, "telegram", [])).toBeUndefined();
  });

  it("builds context with tool names as strings", () => {
    const result = makeResult({
      toolMetas: [
        { toolName: "read", meta: "/tmp/file.ts" },
        { toolName: "exec", meta: "ls -la" },
        { toolName: "read" },
      ],
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "hello world" }]);
    expect(ctx).toBeDefined();
    expect(ctx!.toolCalls).toEqual(["read", "exec", "read"]);
    expect(ctx!.toolCallCount).toBe(3);
  });

  it("computes responseLength from payloads", () => {
    const result = makeResult();
    const ctx = buildAgentContextFromMeta(result, session, "telegram", [
      { text: "hello" },
      { text: " world" },
    ]);
    expect(ctx!.responseLength).toBe(11);
  });

  it("handles payloads with missing text", () => {
    const result = makeResult();
    const ctx = buildAgentContextFromMeta(result, session, "telegram", [
      { text: "ok" },
      {},
      { text: undefined },
    ]);
    expect(ctx!.responseLength).toBe(2);
  });

  it("includes token usage when available", () => {
    const result = makeResult({
      usage: { input: 1000, output: 200, total: 1200 },
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.tokenUsage).toEqual({ input: 1000, output: 200, total: 1200 });
  });

  it("derives total from input + output when total is missing", () => {
    const result = makeResult({
      usage: { input: 800, output: 200 },
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.tokenUsage).toEqual({ input: 800, output: 200, total: 1000 });
  });

  it("defaults input/output to 0 when missing", () => {
    const result = makeResult({
      usage: { total: 500 },
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.tokenUsage).toEqual({ input: 0, output: 0, total: 500 });
  });

  it("omits token usage when agentMeta.usage is absent", () => {
    const result = makeResult({ usage: undefined });
    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.tokenUsage).toBeUndefined();
  });

  it("computes contextFillPercent from lastCallUsage and contextWindow", () => {
    const result = makeResult({
      lastCallUsage: { total: 50000 },
      contextWindow: 200000,
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.contextFillPercent).toBe(25);
  });

  it("returns contextFillPercent undefined when contextWindow is missing", () => {
    const result = makeResult({
      lastCallUsage: { total: 50000 },
      contextWindow: undefined,
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.contextFillPercent).toBeUndefined();
  });

  it("returns contextFillPercent undefined when lastCallUsage.total is missing", () => {
    const result = makeResult({
      lastCallUsage: { input: 1000 },
      contextWindow: 200000,
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.contextFillPercent).toBeUndefined();
  });

  it("rounds contextFillPercent to nearest integer", () => {
    const result = makeResult({
      lastCallUsage: { total: 66666 },
      contextWindow: 200000,
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.contextFillPercent).toBe(33); // 33.333 → 33
  });

  it("clamps contextFillPercent to 100 when usage exceeds context window", () => {
    const result = makeResult({
      lastCallUsage: { total: 250000 },
      contextWindow: 200000,
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.contextFillPercent).toBe(100); // 125% → clamped to 100
  });

  it("threads session identity and channel", () => {
    const result = makeResult();
    const ctx = buildAgentContextFromMeta(result, session, "discord", [{ text: "ok" }]);
    expect(ctx!.agentId).toBe("main");
    expect(ctx!.sessionKey).toBe("agent:main:test");
    expect(ctx!.channel).toBe("discord");
  });

  it("handles undefined outbound session gracefully", () => {
    const result = makeResult();
    const ctx = buildAgentContextFromMeta(result, undefined, "telegram", [{ text: "ok" }]);
    expect(ctx!.agentId).toBeUndefined();
    expect(ctx!.sessionKey).toBeUndefined();
  });

  it("reports 0% when lastCallUsage.total is zero", () => {
    const result = makeResult({
      lastCallUsage: { total: 0 },
      contextWindow: 200000,
    });

    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.contextFillPercent).toBe(0);
  });

  it("returns empty toolCalls array when no tools were invoked", () => {
    const result = makeResult({ toolMetas: [] });
    const ctx = buildAgentContextFromMeta(result, session, "telegram", [{ text: "ok" }]);
    expect(ctx!.toolCalls).toEqual([]);
    expect(ctx!.toolCallCount).toBe(0);
  });
});
