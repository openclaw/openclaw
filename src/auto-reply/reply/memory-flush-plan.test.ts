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

  it("caps reserve and maintenance headroom for an 8000-token context window", () => {
    expect(resolveMemoryFlushPlanForRun({ contextWindowTokens: 8_000 })?.plan).toMatchObject({
      reserveTokensFloor: 2_000,
      softThresholdTokens: 3_000,
    });
  });

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
    expect(resolveMemoryFlushPlanMock).not.toHaveBeenCalled();
  });
});

describe("resolveMemoryFlushPlanForRun", () => {
  afterEach(() => {
    resolveMemoryFlushPlanMock.mockReset();
    memoryFlushWarnMock.mockReset();
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
