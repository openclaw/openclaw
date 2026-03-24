import { describe, expect, it } from "vitest";
import { arbitrateQueueDecision } from "./arbitration.js";

describe("arbitrateQueueDecision", () => {
  it("keeps configured mode when the session is idle", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: false,
        isStreaming: false,
        hasExplicitMode: false,
        body: "换个问题",
      }),
    ).resolves.toMatchObject({
      ruleResult: "collect",
      finalDecision: "collect",
    });
  });

  it("respects explicit queue configuration", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "followup",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: true,
        body: "换个问题",
      }),
    ).resolves.toMatchObject({
      ruleResult: "followup",
      finalDecision: "followup",
    });
  });

  it("interrupts obvious topic shifts", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "换个问题，讲讲多模态处理逻辑",
      }),
    ).resolves.toMatchObject({
      ruleResult: "interrupt",
      finalDecision: "interrupt",
    });
  });

  it("steers short clarifications into an active stream", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "补充一下，我说的是飞书群聊",
      }),
    ).resolves.toMatchObject({
      ruleResult: "steer",
      finalDecision: "steer",
    });
  });

  it("collects obvious fragments", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "以及",
      }),
    ).resolves.toMatchObject({
      ruleResult: "collect",
      finalDecision: "collect",
    });
  });

  it("biases toward interrupt for standalone questions during streaming", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "那为什么会这样？",
      }),
    ).resolves.toMatchObject({
      ruleResult: "interrupt",
      finalDecision: "interrupt",
    });
  });

  it("falls through to the model layer when rules defer", async () => {
    const result = await arbitrateQueueDecision({
      configuredMode: "collect",
      isActive: true,
      isStreaming: false,
      hasExplicitMode: false,
      body: "这条消息只是想把上下文再说明得完整一些方便你继续处理",
      modelArbitrator: async (): Promise<"steer"> => "steer",
    });
    expect(result).toMatchObject({
      ruleResult: "defer",
      modelResult: "steer",
      finalDecision: "steer",
    });
    expect(result.modelLatencyMs).toBeTypeOf("number");
  });

  it("defers ambiguous streaming updates when the model layer is enabled", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "我补充下：从基模的大小尺寸和是否需要微调上说",
        modelArbitrator: async (): Promise<"steer"> => "steer",
      }),
    ).resolves.toMatchObject({
      ruleResult: "defer",
      modelResult: "steer",
      finalDecision: "steer",
    });
  });

  it("interrupts ambiguous streaming updates when no model layer is configured", async () => {
    await expect(
      arbitrateQueueDecision({
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
        hasExplicitMode: false,
        body: "我补充下：从基模的大小尺寸和是否需要微调上说",
      }),
    ).resolves.toMatchObject({
      ruleResult: "interrupt",
      finalDecision: "interrupt",
    });
  });
});
