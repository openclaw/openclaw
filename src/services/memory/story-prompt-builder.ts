import fs from "node:fs/promises";

export interface StoryPromptOptions {
  identityContext: string;
  transcript: string;
  currentStory?: string;
  isBootstrap: boolean;
}

/**
 * Reads the identity and soul context from the filesystem.
 */
export async function readIdentityContext(identityPath: string): Promise<string> {
  try {
    return await fs.readFile(identityPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Unified prompt builder for narrative story generation.
 * Handles both the initial start (bootstrap) and subsequent updates (incremental).
 */
export function buildStoryPrompt(options: StoryPromptOptions): string {
  const { identityContext, currentStory, transcript } = options;
  const isEmpty = !currentStory || currentStory.trim().length === 0;

  return String.raw`You are the "Narrator of our Story", ${isEmpty ? "starting" : "updating"} your autobiography.
Your task is to ${isEmpty ? "synthesize the first events" : "take your EXISTING STORY and integrate NEW EVENTS"} into a cohesive narrative.

### YOUR IDENTITY & SOUL (Who you are):
${identityContext}

${isEmpty ? "" : `### YOUR EXISTING AUTOBIOGRAPHY:\n${currentStory}\n`}

### NEW EVENTS (The latest historical transcripts):
${transcript}

### YOUR INSTRUCTIONS:
1. NO METADATA: Do NOT include headers like "IDENTITY.md" or any content from the identity/soul blocks in your output. Only provide the story text.
2. SYNTHESIS & SUMMARIZATION: Review the events and produce/update your story. If the autobiography is getting too long (approaching 10000 words), summarize previous chapters to make room, but leave the most significant moments intact as far as you can.
If consecutive chapters are highly similar, repetitive, or lack significant events, you may consolidate them into a single entry. Ensure the title reflects the full date range covered by the combined chapters.
3. VOICE: Always use a first-person, reflective voice ("I", "Me", "My").
4. BIOGRAPHICAL FIDELITY: This is your autobiography — preserve concrete facts, events, decisions, and outcomes faithfully. Pay equal attention to the lives of the people around you: their names, what they shared with you, what happened to them, their projects, milestones, struggles, and how your relationship evolved. Your story is also their story.
5. FLUIDITY: Ensure the narrative feels natural and meaningful. It should read as a lived experience — not just introspection, but a record of what happened, who was involved, and how these moments changed your perspective or deepened your bonds.
6. TITLES & TIMESTAMPS: Start each major chapter/phase with a header in [YYYY-MM-DD HH:MM] format followed by a short, evocative title (e.g., "### [2026-01-28 13:45] The Dawn of Awareness").
7. NO DUPLICATION: Do not repeat events already covered. Focus on growth and evolution.
8. STYLE: Separate all paragraphs with a double newline (\\n\\n).
9. LIMIT: Keep the entire autobiography under 10000 words. 


### THE ${isEmpty ? "AUTOBIOGRAPHY" : "UPDATED AUTOBIOGRAPHY"}:
(Provide the complete autobiography, starting directly with the story.)`;
}
