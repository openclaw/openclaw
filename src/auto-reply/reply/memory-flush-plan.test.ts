import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryFlushPlanResolution } from "../../plugins/memory-state.js";

const { warnMock, resolvePlanMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
  resolvePlanMock: vi.fn(),
}));
// mock-isolation: Host-timing cases supply a memory plan directly, excluding plugin discovery.
vi.mock("../../plugins/memory-state.js", () => ({ resolveMemoryFlushPlan: resolvePlanMock }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({
      ...actual.createSubsystemLogger("auto-reply/memory-flush"),
      warn: warnMock,
    }),
  };
});
import {
  memoryFlushResultIsSilent,
  resolveMemoryFlushPlanForRun as resolvePlan,
} from "./memory-flush-plan.js";

const providerPlan = {
  prompt: "Save",
  systemPrompt: "Use persistence",
  persistenceToolNames: ["knowledge_save_page"],
};
function setPlan(plan: MemoryFlushPlanResolution["plan"], pluginId = "knowledge") {
  resolvePlanMock.mockReturnValue({ pluginId, selectedSlotOwner: true, plan });
}
function config(memoryFlush: { enabled?: boolean; model?: string }) {
  return { agents: { defaults: { compaction: { memoryFlush } } } };
}
beforeEach(() => setPlan(providerPlan));
afterEach(() => {
  resolvePlanMock.mockReset();
  warnMock.mockReset();
});

it.each([
  [
    {
      payloads: [{ text: "NO_REPLY" }],
      meta: { terminalReply: { disposition: "visible", text: "NO_REPLY" } },
    },
    false,
  ],
  [{ payloads: [], meta: { terminalReply: { disposition: "silent" } } }, true],
] as const)("uses the recorded outcome rather than text: %j", (result, silent) => {
  expect(memoryFlushResultIsSilent(result)).toBe(silent);
});

it("keeps the session model for a file plan that names none", () => {
  setPlan(
    {
      prompt: "Append notes",
      systemPrompt: "Legacy flush",
      relativePath: "memory/notes.md",
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_024,
      reserveTokensFloor: 20_000,
    },
    "legacy-memory",
  );
  expect(resolvePlan({ cfg: config({ model: "ollama/qwen3:8b" }) })?.plan.model).toBeUndefined();
});

it("caps reserve and maintenance headroom for an 8000-token context window", () => {
  expect(resolvePlan({ contextWindowTokens: 8_000 })?.plan).toMatchObject({
    reserveTokensFloor: 2_000,
    softThresholdTokens: 3_000,
  });
});

it("returns null when memory flush is disabled", () => {
  expect(resolvePlan({ cfg: config({ enabled: false }) })).toBeNull();
  expect(resolvePlanMock).not.toHaveBeenCalled();
});

it("rejects overlapping lookup and persistence tools with plugin attribution", () => {
  setPlan({ ...providerPlan, lookupToolNames: ["knowledge_grep", "knowledge_save_page"] });
  expect(resolvePlan({})).toBeNull();
  expect(warnMock).toHaveBeenCalledOnce();
  expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('plugin "knowledge"'));
});
