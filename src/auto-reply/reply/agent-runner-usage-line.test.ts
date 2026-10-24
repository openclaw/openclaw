import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";

type Usage = Parameters<typeof resolveResponseUsageLine>[0]["usage"];

it("renders a full footer from a reply usage snapshot", () => {
  const replyUsageState = {
    provider: "openai",
    model: "claude-opus-4-6",
    reasoningEffort: "medium",
    fastMode: false,
    fallbackUsed: false,
    contextTokenBudget: 272000,
    contextUsedTokens: 204000,
    usage: { input: 204000, output: 15, cacheRead: 0, cacheWrite: 0, total: 204015 },
    turnUsd: 0.03771985,
  };
  const pieces = [
    { text: "{model.display_name|alias:models}" },
    { map: "model.is_fallback", cases: { true: "🔄" } },
    { text: " | " },
    { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
    { map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } },
    { text: " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}" },
    { text: " | ${cost.turn_usd|fixed:4}" },
  ];
  const line = resolveResponseUsageLine({
    config: {
      messages: {
        responseUsage: "full",
        usageTemplate: {
          scales: {
            braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
          },
          aliases: {
            models: { "claude-opus-4-6": "opus46" },
            reasoning: { medium: "med" },
          },
          output: { sep: "", surfaces: { discord: pieces } },
        },
      },
    },
    agentDir: "/synthetic/usage-contract-agent",
    channel: "discord",
    usage: replyUsageState.usage,
    replyUsageState,
  });
  expect(line).toBe("opus46 | med🐌 | 📚 [⣿⣿⣿⣧⠐]272k | $0.0377");
});
const usageLine = "Usage: 12 in / 3 out";

it("marks a standalone usage footer as non-terminal status", () => {
  const mediaUrl = "file:///tmp/result.png";
  expect(appendUsageLine([{ mediaUrl }], usageLine)).toEqual([
    { mediaUrl },
    { text: usageLine, isStatusNotice: true },
  ]);
});

const completeUsage = { input: 1_000_000, output: 0 };
it.each<[name: string, usage: Usage, tiered: boolean, expected: string | undefined]>([
  ["costless flat-price runtime", completeUsage, false, "est $1.00"],
  ["explicit zero total", { ...completeUsage, cost: { total: 0 } }, true, "est $0.0000"],
  ["incomplete tiered cost", completeUsage, true, undefined],
  ["input-only usage without a price", { input: 1_000_000 }, false, undefined],
  ["output-only usage without a price", { output: 50 }, false, undefined],
  ["priced partial usage", { input: 1000, cost: { total: 0.25 } }, true, "est $0.25"],
  ["cost-only zero total", { cost: { total: 0 } }, true, "Usage: ? in / ? out · est $0.0000"],
])("formats %s for the selected agent in an explicit fleet", (_name, usage, tiered, expected) => {
  const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const model: ModelDefinitionConfig = {
    id: "priced",
    name: "Priced",
    reasoning: false,
    input: ["text"],
    contextWindow: 1,
    maxTokens: 1,
    cost: {
      ...cost,
      tieredPricing: tiered ? [{ ...cost, input: 2, output: 0, range: [200_000] }] : undefined,
    },
  };
  const line = resolveResponseUsageLine({
    config: {
      agents: { ownership: "explicit", entries: { main: {}, other: {} } },
      messages: { responseUsage: "full" },
      models: { providers: { fixture: { baseUrl: "https://fixture.invalid", models: [model] } } },
    },
    agentDir: "/tmp/openclaw-main-agent",
    usage,
    provider: "fixture",
    model: "priced",
  });

  expect(line).toContain("Usage:");
  if (expected) {
    expect(line).toContain(expected);
  } else {
    expect(line).not.toContain("est $");
  }
});

it.each(["off", "tokens"] as const)("hides cost-only usage in %s mode", (mode) => {
  expect(
    resolveResponseUsageLine({
      config: { messages: { responseUsage: mode } },
      agentDir: "/tmp/openclaw-main-agent",
      usage: { cost: { total: 0.25 } },
    }),
  ).toBeUndefined();
});

it("decorates a completed source reply and keeps its private final separate", () => {
  const mirror = {
    sessionKey: "agent:main:telegram:direct:123",
    agentId: "main",
    text: "message tool reply",
    idempotencyKey: "run-1:internal-source-reply:0",
  };
  const payload = setReplyPayloadMetadata(
    { text: "message tool reply" },
    {
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: mirror,
    },
  );

  const privateFinal = { text: "private final" };
  const [updated, untouchedPrivateFinal] = appendUsageLine([payload, privateFinal], usageLine, {
    completedSourceReply: true,
  });

  expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
  expect(untouchedPrivateFinal).toBe(privateFinal);
  expect(getReplyPayloadMetadata(privateFinal)).toBeUndefined();
  expect(getReplyPayloadMetadata(expectDefined(updated, "updated test invariant"))).toMatchObject({
    deliverDespiteSourceReplySuppression: true,
    sourceReplyTranscriptMirror: {
      ...mirror,
      text: "message tool reply\nUsage: 12 in / 3 out",
    },
  });
});

it("emits a suppression-authorized footer when no captured source payload exists", () => {
  const result = appendUsageLine([{ text: "private final" }], usageLine, {
    completedSourceReply: true,
  });

  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ text: "private final" });
  expect(result[1]).toMatchObject({ text: usageLine, isStatusNotice: true });
  expect(
    getReplyPayloadMetadata(expectDefined(result[1], "completed source footer")),
  ).toMatchObject({
    deliverDespiteSourceReplySuppression: true,
    responseUsageLine: usageLine,
  });
});
