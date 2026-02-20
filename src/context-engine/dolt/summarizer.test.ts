import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { DOLT_BINDLE_PROMPT_DEFAULT, DOLT_LEAF_PROMPT_DEFAULT } from "./prompts.js";
import {
  DOLT_LEAF_MIN_SOURCE_TURNS,
  DOLT_SUMMARY_MAX_OUTPUT_TOKENS,
  buildDoltSummaryPrompt,
  resolveDoltSummaryModelSelection,
  summarizeDoltRollup,
} from "./summarizer.js";

const BASE_SOURCE = [
  {
    pointer: "turn-001",
    role: "user",
    content: "Need a plan for migration.",
    timestampMs: 1000,
  },
  {
    pointer: "turn-002",
    role: "assistant",
    content: "Plan drafted with risks and constraints.",
    timestampMs: 2000,
    safetyRelevantToolOutcome: true,
  },
];

describe("resolveDoltSummaryModelSelection", () => {
  it("uses defaults when no explicit model/provider are supplied", () => {
    expect(resolveDoltSummaryModelSelection({})).toEqual({
      provider: DEFAULT_PROVIDER,
      modelId: DEFAULT_MODEL,
    });
  });

  it("uses explicit overrides when provided", () => {
    expect(
      resolveDoltSummaryModelSelection({
        provider: "openai",
        model: "gpt-4.1",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-5",
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });
});

describe("summarizeDoltRollup", () => {
  it("enforces source floor for leaf rollups", async () => {
    await expect(
      summarizeDoltRollup({
        sourceTurns: [BASE_SOURCE[0]],
        mode: "leaf",
        datesCovered: { startEpochMs: 1000, endEpochMs: 1000 },
        childPointers: ["turn-001"],
        runPrompt: vi.fn(async () => "summary"),
      }),
    ).rejects.toThrow(
      `Leaf rollups require at least ${DOLT_LEAF_MIN_SOURCE_TURNS} source turns; received 1.`,
    );
  });

  it("allows reset short-bindle rollups below the leaf source floor", async () => {
    const runPrompt = vi.fn(async () => "reset closure");
    const result = await summarizeDoltRollup({
      sourceTurns: [BASE_SOURCE[0]],
      mode: "reset-short-bindle",
      datesCovered: { startEpochMs: 1000, endEpochMs: 1000 },
      childPointers: ["turn-001"],
      runPrompt,
    });
    expect(result.metadata.finalized_at_reset).toBe(true);
    expect(result.metadata.summary_type).toBe("bindle");
    expect(result.summary).toContain("finalized-at-reset: true");
  });

  it("passes hard token cap and resolved model selection to prompt runner", async () => {
    const runPrompt = vi.fn(async () => "contract summary");
    await summarizeDoltRollup({
      sourceTurns: BASE_SOURCE,
      mode: "bindle",
      datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
      childPointers: ["leaf-001", "leaf-002"],
      provider: "openai",
      model: "gpt-4.1-mini",
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      runPrompt,
    });
    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: DOLT_SUMMARY_MAX_OUTPUT_TOKENS,
        modelSelection: {
          provider: "anthropic",
          modelId: "claude-opus-4-6",
        },
      }),
    );
  });

  it("normalizes output to include required front-matter fields", async () => {
    const result = await summarizeDoltRollup({
      sourceTurns: BASE_SOURCE,
      mode: "leaf",
      datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
      childPointers: ["turn-001", "turn-002"],
      runPrompt: vi.fn(async () => "Leaf summary body"),
    });
    expect(result.metadata).toEqual({
      summary_type: "leaf",
      finalized_at_reset: false,
      prompt_template: "leaf",
      max_output_tokens: DOLT_SUMMARY_MAX_OUTPUT_TOKENS,
    });
    expect(result.summary).toContain("summary-type: leaf");
    expect(result.summary).toContain("finalized-at-reset: false");
    expect(result.summary).toContain("Leaf summary body");
  });
});

describe("buildDoltSummaryPrompt", () => {
  it("uses leaf instruction text and includes front-matter and source material", () => {
    const prompt = buildDoltSummaryPrompt({
      template: {
        id: "leaf",
        label: "normal leaf rollup",
        summaryType: "leaf",
      },
      sourceTurns: BASE_SOURCE,
      childPointers: ["turn-001", "turn-002"],
      datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
      finalizedAtReset: false,
      instructionText: DOLT_LEAF_PROMPT_DEFAULT,
    });
    expect(prompt).toContain("LEAF summary");
    expect(prompt).toContain("State changes:");
    expect(prompt).toContain("Open threads:");
    expect(prompt).toContain("RETRIEVABLE:");
    expect(prompt).toContain("finalized-at-reset: false");
    expect(prompt).toContain(
      "pointer=turn-002 role=assistant ts=2000 safety_relevant_tool_outcome=true",
    );
  });

  it("uses bindle instruction text for bindle mode", () => {
    const prompt = buildDoltSummaryPrompt({
      template: {
        id: "bindle",
        label: "normal bindle rollup",
        summaryType: "bindle",
      },
      sourceTurns: BASE_SOURCE,
      childPointers: ["leaf-001", "leaf-002"],
      datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
      finalizedAtReset: false,
      instructionText: DOLT_BINDLE_PROMPT_DEFAULT,
    });
    expect(prompt).toContain("BINDLE summary");
    expect(prompt).toContain("Thread map:");
    expect(prompt).toContain("Cross-leaf continuity:");
    expect(prompt).toContain("ROUTING");
    expect(prompt).toContain("finalized-at-reset: false");
  });

  it("accepts custom instruction text from file overrides", () => {
    const customInstructions = "You are a custom summarizer. Do your thing.";
    const prompt = buildDoltSummaryPrompt({
      template: {
        id: "leaf",
        label: "normal leaf rollup",
        summaryType: "leaf",
      },
      sourceTurns: BASE_SOURCE,
      childPointers: ["turn-001"],
      datesCovered: { startEpochMs: 1000, endEpochMs: 2000 },
      finalizedAtReset: false,
      instructionText: customInstructions,
    });
    expect(prompt).toContain("You are a custom summarizer");
    expect(prompt).toContain("finalized-at-reset: false");
    expect(prompt).toContain("Source material:");
  });
});
