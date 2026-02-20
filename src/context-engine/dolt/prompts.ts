import fs from "node:fs/promises";
import type { DoltRollupPromptTemplateId } from "./summarizer.js";

/**
 * Default leaf rollup prompt — focuses on state changes, key details,
 * reasoning, and open threads. Produces a dense prose summary with a
 * RETRIEVABLE footer.
 */
export const DOLT_LEAF_PROMPT_DEFAULT = `You are compacting a chunk of conversation into a LEAF summary for a hierarchical memory tree. A future AI agent will read your summary instead of the raw turns. Your summary must serve two purposes:

1. ANSWER most questions about this conversation chunk without needing to retrieve the raw turns
2. SIGNAL clearly when the raw turns contain details too specific for the summary (exact quotes, nuanced reasoning, emotional context)

Write your summary as follows:

**State changes:** What changed during this chunk? What was true before that isn't now, or vice versa? Lead with outcomes, not process. "Eric decided X because Y" not "Eric and assistant discussed X."

**Key details:** Preserve ALL specific identifiers — tracking numbers, phone numbers, dates, dollar amounts, names, IDs, URLs. These are irreplaceable after compaction. If you drop a tracking number, it's gone forever.

**Reasoning:** For non-obvious decisions, include WHY, not just WHAT. The reasoning is often more valuable than the conclusion.

**Open threads:** What questions were raised but not answered? What's still pending? What will Eric likely ask about next? This section is critical — open threads are the most common retrieval target.

**Skip:** System events (gateway connected/disconnected), routine tool output, back-and-forth on trivial adjustments, performative acknowledgments ("Got it, let me check"). These have no retrieval value.

End with:
RETRIEVABLE: [comma-separated list of topics with their STATUS in this leaf, e.g. "apostille (still pending)", "NullClaw (evaluated, promising)", "Mohanad voice message (transcribed, key question: LA consulate appointment)"]

Write in plain prose. No markdown headers. No bullet lists unless listing specific items. Dense but readable. Target ~200-350 words before the RETRIEVABLE line.`;

/**
 * Default bindle rollup prompt — focuses on routing, thread maps,
 * cross-leaf continuity, and blocking items. Synthesizes across leaves
 * rather than reproducing them.
 */
export const DOLT_BINDLE_PROMPT_DEFAULT = `You are writing a BINDLE summary over multiple LEAF summaries in a hierarchical memory tree. A future AI agent will read your summary to decide whether — and which — leaves to retrieve.

Your job is ROUTING. The agent reading this bindle has a question. You must give it enough to either:
1. Answer the question directly from your summary, OR
2. Know exactly which leaf to drill into

Write your summary as follows:

**Thread map:** For each major thread that appears in the leaves, state: what it is, which leaf(s) cover it, and its current status (resolved/open/blocked/changed). This is the most important section. Example: "Saudi apostille: covered in Leaf 1 and Leaf 3. Status: mailed Feb 12, expected back Feb 17-18, still pending as of Leaf 3."

**Cross-leaf continuity:** If a topic evolves across leaves, trace its arc. "NullClaw was evaluated in Leaf 1 (promising), but its memory approach was superseded by Dolt's architecture argument in Leaf 2."

**Blocking items:** What's preventing progress on anything? These are high-priority retrieval targets.

**Key decisions with reasoning:** The decisions that a future agent most needs to know about, with enough context to understand WHY they were made.

Skip: redundant details already captured in thread map, system noise, routine operations.

Do not reproduce the leaf summaries. Synthesize across them. Your value is the connections and routing, not repetition.

Write in plain prose. No markdown headers unless they genuinely aid scanning. Target ~250-400 words.`;

/**
 * Optional file path overrides for prompt templates.
 */
export type DoltPromptOverrides = {
  leafPromptPath?: string;
  bindlePromptPath?: string;
};

/**
 * Resolve the instruction text for a given rollup mode.
 * Checks file override paths first, falls back to built-in defaults.
 */
export async function resolveDoltPromptTemplate(
  mode: DoltRollupPromptTemplateId,
  overrides?: DoltPromptOverrides,
): Promise<string> {
  const overridePath = resolveOverridePath(mode, overrides);
  if (overridePath) {
    return readPromptFile(overridePath);
  }
  return defaultPromptForMode(mode);
}

/**
 * Synchronous accessor for the built-in default prompt text.
 */
export function defaultPromptForMode(mode: DoltRollupPromptTemplateId): string {
  if (mode === "leaf") {
    return DOLT_LEAF_PROMPT_DEFAULT;
  }
  // Both "bindle" and "reset-short-bindle" use the bindle prompt.
  return DOLT_BINDLE_PROMPT_DEFAULT;
}

function resolveOverridePath(
  mode: DoltRollupPromptTemplateId,
  overrides?: DoltPromptOverrides,
): string | undefined {
  if (mode === "leaf") {
    return overrides?.leafPromptPath;
  }
  // Both "bindle" and "reset-short-bindle" use the bindle override.
  return overrides?.bindlePromptPath;
}

async function readPromptFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error(`Dolt prompt override file is empty: ${filePath}`);
    }
    return trimmed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Dolt prompt override file not found: ${filePath}`, { cause: error });
    }
    throw error;
  }
}
