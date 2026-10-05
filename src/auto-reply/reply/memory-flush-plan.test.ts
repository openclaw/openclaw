import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { memoryFlushWarnMock, resolveMemoryFlushPlanMock } = vi.hoisted(() => ({
  memoryFlushWarnMock: vi.fn(),
  resolveMemoryFlushPlanMock: vi.fn(),
}));

vi.mock("../../plugins/memory-state.js", () => ({
  resolveMemoryFlushPlan: resolveMemoryFlushPlanMock,
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({
      ...actual.createSubsystemLogger("auto-reply/memory-flush"),
      warn: memoryFlushWarnMock,
    }),
  };
});

import { resolveMemoryFlushPlanForRun } from "./memory-flush-plan.js";

describe("resolveMemoryFlushPlanForRun host timing", () => {
  const providerPlan = {
    prompt: "Save durable knowledge",
    systemPrompt: "Use the Knowledge persistence tool",
    persistenceToolNames: ["knowledge_save_page"],
  };

  beforeEach(() => {
    resolveMemoryFlushPlanMock.mockReturnValue({
      pluginId: "knowledge",
      selectedSlotOwner: true,
      plan: providerPlan,
    });
  });

  afterEach(() => {
    resolveMemoryFlushPlanMock.mockReset();
    memoryFlushWarnMock.mockReset();
  });

  it("resolves default timing and model config", () => {
    expect(resolveMemoryFlushPlanForRun({})?.plan).toEqual({
      ...providerPlan,
      model: undefined,
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 2 * 1024 * 1024,
      reserveTokensFloor: 20_000,
    });
    expect(
      resolveMemoryFlushPlanForRun({
        cfg: {
          agents: {
            defaults: {
              compaction: {
                memoryFlush: {
                  model: " ollama/qwen3:8b ",
                  softThresholdTokens: 1_250.9,
                  forceFlushTranscriptBytes: "3mb",
                },
              },
            },
          },
        },
      })?.plan,
    ).toEqual({
      ...providerPlan,
      softThresholdTokens: 1_250,
      forceFlushTranscriptBytes: 3 * 1024 * 1024,
      reserveTokensFloor: 20_000,
      model: "ollama/qwen3:8b",
    });
  });

  it("keeps the session model for a file plan that names none", () => {
    resolveMemoryFlushPlanMock.mockReturnValue({
      pluginId: "legacy-memory",
      selectedSlotOwner: true,
      plan: {
        prompt: "Append notes",
        systemPrompt: "Legacy flush",
        relativePath: "memory/notes.md",
        softThresholdTokens: 4_000,
        forceFlushTranscriptBytes: 1_024,
        reserveTokensFloor: 20_000,
      },
    });

    expect(
      resolveMemoryFlushPlanForRun({
        cfg: {
          agents: { defaults: { compaction: { memoryFlush: { model: "ollama/qwen3:8b" } } } },
        },
      })?.plan.model,
    ).toBeUndefined();
  });

  it("falls back when configured timing values are invalid", () => {
    expect(
      resolveMemoryFlushPlanForRun({
        cfg: {
          agents: {
            defaults: {
              compaction: {
                memoryFlush: {
                  softThresholdTokens: -100,
                  forceFlushTranscriptBytes: "invalid",
                },
              },
            },
          },
        },
      })?.plan,
    ).toEqual({
      ...providerPlan,
      model: undefined,
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 2 * 1024 * 1024,
      reserveTokensFloor: 20_000,
    });
  });

  it.each([
    [8_000, 2_000, 3_000],
    [32_768, 8_192, 4_000],
    [128_000, 20_000, 4_000],
  ])(
    "caps reserve and maintenance headroom for a %i-token context window",
    (contextWindowTokens, reserveTokensFloor, softThresholdTokens) => {
      expect(resolveMemoryFlushPlanForRun({ contextWindowTokens })?.plan).toMatchObject({
        reserveTokensFloor,
        softThresholdTokens,
      });
    },
  );

  it("returns null when memory flush is disabled", () => {
    expect(
      resolveMemoryFlushPlanForRun({
        cfg: {
          agents: {
            defaults: { compaction: { memoryFlush: { enabled: false } } },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("resolveMemoryFlushPlanForRun", () => {
  afterEach(() => {
    resolveMemoryFlushPlanMock.mockReset();
    memoryFlushWarnMock.mockReset();
  });

  it("does not invoke the provider resolver when flush timing is disabled", () => {
    expect(
      resolveMemoryFlushPlanForRun({
        cfg: {
          agents: {
            defaults: { compaction: { memoryFlush: { enabled: false } } },
          },
        },
      }),
    ).toBeNull();
    expect(resolveMemoryFlushPlanMock).not.toHaveBeenCalled();
  });

  it("fills omitted timing and preserves deliberate provider overrides", () => {
    resolveMemoryFlushPlanMock
      .mockReturnValueOnce({
        pluginId: "knowledge",
        selectedSlotOwner: true,
        plan: {
          prompt: "Save durable knowledge",
          systemPrompt: "Use the Knowledge persistence tool",
          persistenceToolNames: ["knowledge_save_page"],
        },
      })
      .mockReturnValueOnce({
        pluginId: "knowledge",
        selectedSlotOwner: true,
        plan: {
          softThresholdTokens: 12,
          forceFlushTranscriptBytes: 34,
          reserveTokensFloor: 56,
          model: "provider/model",
          prompt: "Save durable knowledge",
          systemPrompt: "Use the Knowledge persistence tool",
          persistenceToolNames: ["knowledge_save_page"],
        },
      });

    expect(resolveMemoryFlushPlanForRun({})?.plan).toMatchObject({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 2 * 1024 * 1024,
      reserveTokensFloor: 20_000,
    });
    expect(resolveMemoryFlushPlanForRun({})?.plan).toMatchObject({
      softThresholdTokens: 12,
      forceFlushTranscriptBytes: 34,
      reserveTokensFloor: 56,
      model: "provider/model",
    });
  });

  it("rejects overlapping lookup and persistence tools with plugin attribution", () => {
    resolveMemoryFlushPlanMock.mockReturnValue({
      pluginId: "knowledge",
      selectedSlotOwner: true,
      plan: {
        prompt: "Save durable knowledge",
        systemPrompt: "Use Knowledge tools",
        persistenceToolNames: ["knowledge_save_page"],
        lookupToolNames: ["knowledge_grep", "knowledge_save_page"],
      },
    });

    expect(resolveMemoryFlushPlanForRun({})).toBeNull();
    expect(memoryFlushWarnMock).toHaveBeenCalledOnce();
    expect(memoryFlushWarnMock).toHaveBeenCalledWith(expect.stringContaining('plugin "knowledge"'));
  });
});
