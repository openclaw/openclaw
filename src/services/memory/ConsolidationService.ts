import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { withFileLock, type FileLockOptions } from "../../infra/file-lock.js";
import { GraphService } from "./GraphService.js";
import { buildStoryPrompt } from "./story-prompt-builder.js";

/**
 * Extracts story sections from the last `days` calendar days using the `### [YYYY-MM-DD` header
 * format written by the narrative consolidator. Falls back to the last 3 sections if none match.
 */
function extractRecentStorySections(story: string, days: number): string {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // Split on section headers, keeping the delimiter at the start of each chunk.
  const sections = story.split(/(?=^### \[)/m).filter(Boolean);
  const datePattern = /^### \[(\d{4}-\d{2}-\d{2})/m;
  const recent = sections.filter((section) => {
    const match = section.match(datePattern);
    if (!match) {
      return false;
    }
    return new Date(match[1]).getTime() >= cutoff;
  });
  if (recent.length > 0) {
    return recent.join("");
  }
  // Fallback: last 3 sections so "current focus" is never empty.
  return sections.slice(-3).join("");
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const obj = value as Record<string, unknown>;
  const textCandidate = obj.content ?? obj.message ?? obj.response;
  return typeof textCandidate === "string" ? textCandidate : "";
}

/**
 * Lock options for STORY.md writes. All three writers (syncGlobalNarrative,
 * post-compaction syncStoryWithSession, pre-compaction syncStoryWithSession)
 * funnel through updateNarrativeStory which acquires this lock.
 * The lock file is created at `<storyPath>.lock`.
 */
const STORY_LOCK_OPTIONS: FileLockOptions = {
  retries: { retries: 10, factor: 2, minTimeout: 200, maxTimeout: 15_000, randomize: true },
  stale: 120_000, // 2 min stale detection
};

export class ConsolidationService {
  private readonly graph: GraphService;
  private readonly debug: boolean;

  constructor(graph: GraphService, debug: boolean = false) {
    this.graph = graph;
    this.debug = debug;
  }

  private log(message: string) {
    if (this.debug) {
      process.stderr.write(`${message}\n`);
    }
  }

  private isHeartbeatMessage(text: string): boolean {
    const isPrompt = text.includes("Read HEARTBEAT.md") && text.includes("HEARTBEAT_OK");
    const isResponse = text.trim() === "HEARTBEAT_OK";
    return isPrompt || isResponse;
  }

  // REMOVED: consolidateMessages() - Graphiti automatically extracts entities and relationships from episodes.
  // No need for manual triplet extraction.

  /**
   * Summarize a conversation chunk (array of {role, text} turns) into structured facts
   * using a small LLM + QUICK.md context. Falls back to raw transcript if no agent provided.
   */
  async summarizeConversationChunk(
    messages: Array<{ role: string; text: string }>,
    agent:
      | { complete: (prompt: string, systemPrompt?: string) => Promise<{ text?: string | null }> }
      | undefined,
    glossaryContext?: string,
  ): Promise<string> {
    // Clean Telegram/MindFace metadata from messages and resolve display names
    const cleanedMessages = messages
      .map((m) => {
        let text = m.text;
        // Extract sender name from Telegram metadata
        const metaName = text.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
        const mfName = text.match(/^🎙️?\s*\(De ([^)]+)\)/)?.[1];
        const displayRole = m.role === "assistant" ? "Mind" : (metaName ?? mfName ?? m.role);
        text = text
          .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/g, "")
          .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```/g, "")
          .replace(/^🎙️?\s*(?:\(De [^)]+\):)?\s*/m, "")
          .trim();
        return { role: displayRole, text };
      })
      .filter((m) => m.text.length > 0);

    const transcript = cleanedMessages.map((m) => `[${m.role}]: ${m.text}`).join("\n\n");

    if (!agent) {
      return transcript;
    }

    const systemPrompt = glossaryContext?.trim()
      ? `You extract memory facts. Use this name reference ONLY to resolve pronouns — never output it: ${glossaryContext.trim().split("\n").join(" | ")}`
      : undefined;

    const prompt = `You are a memory extraction assistant. Extract factual statements from a conversation chunk.

CONVERSATION:
${transcript}

TASK:
The LAST message in the conversation is the one being stored as a memory episode.
Extract 3-6 concise factual statements that capture what is revealed or decided in that last message.
Use the earlier conversation only for context to understand the last message.

Each fact should:
- Be a complete standalone sentence (subject + verb + object)
- Use real names instead of pronouns (e.g. "Julio" not "the user", "Mind" not "the assistant")
- Be in English
- Focus on concrete facts, decisions, plans, or events — not meta-observations

Output one fact per line. No bullets, numbers, or explanations.`;

    try {
      const response = await agent.complete(prompt, systemPrompt);
      const text = (response?.text ?? "").trim();
      return text.length > 10 ? text : transcript;
    } catch {
      return transcript;
    }
  }

  /**
   * Bootstrap historical episodes into Graphiti if the graph is empty.
   * This should be called BEFORE flashback retrieval to ensure historical context is available.
   */
  async bootstrapHistoricalEpisodes(
    sessionId: string,
    memoryDir: string,
    _sessionMessages: Array<unknown> = [],
    workspaceDir?: string,
    _chunkSize: number = 12000,
    sessionsDir?: string,
    agent?: { complete: (prompt: string) => Promise<{ text?: string | null }> },
    quickContext?: string,
  ): Promise<void> {
    try {
      // Check if bootstrap has already been done using a flag file
      const bootstrapFlagPath = path.join(memoryDir, ".graphiti-bootstrap-done");
      const bootstrapProgressPath = path.join(memoryDir, ".graphiti-bootstrap-progress");

      try {
        await fs.access(bootstrapFlagPath);
        return;
      } catch {
        // Continue to bootstrap
      }

      // Load already-processed files from progress file (crash recovery)
      let processedFiles: Set<string> = new Set();
      try {
        const progress = await fs.readFile(bootstrapProgressPath, "utf-8");
        processedFiles = new Set(progress.split("\n").filter(Boolean));
        if (processedFiles.size > 0) {
          this.log(
            `🔄 [MIND] Resuming bootstrap — ${processedFiles.size} items already processed.`,
          );
        }
      } catch {
        // No progress file yet
      }

      this.log(`📥 [MIND] No bootstrap flag found. Ingesting session history into Graphiti...`);

      // Collect all messages from all session files in chronological order
      const allMessages: Array<{
        role: string;
        text: string;
        timestamp: number;
        sessionFile: string;
      }> = [];

      const targetDir = sessionsDir ?? workspaceDir ?? memoryDir;
      let sessionFiles: string[] = [];
      try {
        const entries = await fs.readdir(targetDir);
        sessionFiles = entries
          .filter(
            (f) => !f.includes(".deleted") && (f.endsWith(".jsonl") || f.includes(".jsonl.reset.")),
          )
          .map((f) => path.join(targetDir, f));
      } catch {
        // no sessions dir
      }

      this.log(`📂 [MIND] Found ${sessionFiles.length} session files to process.`);

      for (const sessionFile of sessionFiles) {
        try {
          const content = await fs.readFile(sessionFile, "utf-8");
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            let entry: {
              type: string;
              timestamp?: string | number;
              message?: { role?: string; content?: unknown };
            };
            try {
              entry = JSON.parse(trimmed);
            } catch {
              continue;
            }
            if (entry.type !== "message" || !entry.message) {
              continue;
            }
            const role = entry.message.role ?? "unknown";
            if (role !== "user" && role !== "assistant") {
              continue;
            }
            let text = "";
            const c = entry.message.content;
            if (typeof c === "string") {
              text = c;
            } else if (Array.isArray(c)) {
              text = (c as Array<{ type?: string; text?: string }>)
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join(" ");
            }
            text = text.trim();
            if (!text || this.isHeartbeatMessage(text)) {
              continue;
            }
            const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
            allMessages.push({
              role,
              text,
              timestamp: ts,
              sessionFile: path.basename(sessionFile),
            });
          }
        } catch {
          // skip unreadable files
        }
      }

      // Sort chronologically (oldest first)
      allMessages.sort((a, b) => a.timestamp - b.timestamp);
      this.log(`📊 [MIND] Total messages to process: ${allMessages.length}`);

      // Process in batches of 8, summarize each batch, add as episode
      const BATCH_SIZE = 8;
      let batchIndex = 0;

      for (let i = 0; i < allMessages.length; i += BATCH_SIZE) {
        const batch = allMessages.slice(i, i + BATCH_SIZE);
        const batchKey = `__batch__${i}`;

        if (processedFiles.has(batchKey)) {
          batchIndex++;
          continue;
        }

        const episodeTimestamp = batch[batch.length - 1]?.timestamp
          ? new Date(batch[batch.length - 1].timestamp).toISOString()
          : undefined;

        const chunkMsgs = batch.map((m) => ({ role: m.role, text: m.text.slice(0, 600) }));
        this.log(
          `📥 [MIND] Bootstrap batch ${batchIndex + 1} (msgs ${i + 1}-${i + batch.length}, ${episodeTimestamp?.slice(0, 10) ?? "?"})`,
        );

        const episodeBody = await this.summarizeConversationChunk(chunkMsgs, agent, quickContext);

        await this.graph.addEpisode("global_user_memory", episodeBody, episodeTimestamp, {
          source: "bootstrap-session",
        });

        await fs.appendFile(bootstrapProgressPath, `${batchKey}\n`);
        batchIndex++;
      }

      await fs.writeFile(bootstrapFlagPath, new Date().toISOString());
      try {
        await fs.unlink(bootstrapProgressPath);
      } catch {
        // Progress file may not exist if no files were processed
      }
      this.log(`🏁 [MIND] Bootstrap complete. Episodes queued for Graphiti.`);
    } catch (e: unknown) {
      process.stderr.write(
        `⚠️ [MIND] Historical bootstrap failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * Updates the lifelong narrative story by merging old messages into the existing story.
   * This implements the "Story" concept from the Mind architecture.
   */
  async updateNarrativeStory(
    sessionId: string,
    oldMessages:
      | Array<{
          role?: string;
          text?: string;
          content?: unknown;
          timestamp?: number | string;
          created_at?: string;
          body?: string;
          episode_body?: string;
        }>
      | string,
    currentStory: string,
    storyPath: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
    identityContext?: string,
    anchorTimestamp?: number,
    onEvent?: (event: { stream: string; data: unknown }) => void,
  ): Promise<string> {
    if (typeof oldMessages !== "string" && oldMessages.length === 0) {
      return currentStory;
    }

    if (onEvent) {
      onEvent({
        stream: "tool",
        data: {
          tool: "narrative_update",
          phase: "call",
          status: "Actualizando historia...",
        },
      });
    }

    this.log(`📖 [MIND] Updating Narrative Story for ${sessionId}...`);

    const transcript = Array.isArray(oldMessages)
      ? oldMessages
          .map((m) => {
            const timestamp = m.timestamp ?? m.created_at ?? Date.now();
            const date = new Date(timestamp);
            // Handle Graphiti raw episode format { body: "..." } or Message { text/content }
            let text = m.body || m.text || (m.content as string) || m.episode_body || "";
            if (Array.isArray(text)) {
              text = (text as unknown[])
                .map((c: unknown) => {
                  if (typeof c === "string") {
                    return c;
                  }
                  const part = c as { text?: string; content?: string };
                  return part.text ?? part.content ?? "";
                })
                .join(" ");
            }
            if (this.isHeartbeatMessage(text)) {
              return null;
            }

            return `[${date.toISOString()}] ${m.role || "unknown"}: ${text}`;
          })
          .filter((line): line is string => line !== null)
          .join("\n")
      : oldMessages; // Assume it is already a formatted transcript string

    // Decide strategy based on whether we have existing story
    const isBootstrap = !currentStory || currentStory.trim().length === 0;

    const prompt = buildStoryPrompt({
      identityContext: identityContext || "You are a helpful and soulful AI assistant.",
      transcript,
      currentStory: currentStory || "",
      isBootstrap,
    });

    // DEBUG: Log the COMPLETE prompt being sent to LLM - REMOVED PER USER REQUEST

    const promptLength = prompt.length;
    const promptTokensEstimate = Math.ceil(promptLength / 4); // rough estimate

    try {
      const startTime = Date.now();
      const response = await agent.complete(prompt);
      const elapsed = Date.now() - startTime;

      this.log(
        `🤖 [MIND] LLM call completed in ${elapsed}ms (prompt: ${promptLength} chars / ~${promptTokensEstimate} tokens)`,
      );

      if (!response) {
        process.stderr.write(`❌ [MIND] LLM returned null/undefined response\n`);
        process.stderr.write(`   Session ID: ${sessionId}\n`);
        return currentStory;
      }

      // CRITICAL: Validate that response.text is actually a string, not an object

      // Debug: Log what we received if it's not a string
      if (typeof response?.text !== "string") {
        process.stderr.write(`⚠️ [MIND] Unexpected response.text type: ${typeof response?.text}\n`);
        process.stderr.write(`response.text value: ${JSON.stringify(response?.text)}\n`);
        if (response) {
          process.stderr.write(`Full response keys: ${Object.keys(response).join(", ")}\n`);
        }
      }

      const rawStory: unknown = response?.text;

      if (typeof rawStory === "string" && rawStory.length === 0) {
        process.stderr.write(`⚠️ [MIND] LLM returned empty string\n`);
        process.stderr.write(
          `   Prompt length: ${promptLength} chars / ~${promptTokensEstimate} tokens\n`,
        );
        process.stderr.write(`   Elapsed: ${elapsed}ms\n`);
      }

      // DEBUG: Log first 300 chars - REMOVED PER USER REQUEST

      // Use the complete generated story directly
      // Ensure newStory is always a string with proper validation
      let newStory = "";

      if (typeof rawStory === "string") {
        newStory = rawStory;
      } else if (rawStory && typeof rawStory === "object") {
        // If it's an object, try to extract text from common properties
        const obj = rawStory as Record<string, unknown>;
        newStory = extractTextFromUnknown(rawStory);

        if (!newStory) {
          process.stderr.write(
            `❌ [MIND] Story update error: LLM returned object instead of string\n`,
          );
          process.stderr.write(
            `Response type: ${typeof rawStory}, keys: ${Object.keys(obj).join(", ")}\n`,
          );
          try {
            process.stderr.write(`Full response: ${JSON.stringify(response, null, 2)}\n`);
            process.stderr.write(
              `response.text type: ${typeof response?.text}, is null: ${response?.text === null}\n`,
            );
          } catch (e) {
            process.stderr.write(`Cannot stringify response: ${String(e)}\n`);
          }
          return currentStory;
        }
      }

      if (!newStory || newStory.trim().length === 0) {
        process.stderr.write(`❌ [MIND] Story update error: LLM returned empty response\n`);
        process.stderr.write(`   Session ID: ${sessionId}\n`);
        process.stderr.write(
          `   Messages count: ${Array.isArray(oldMessages) ? oldMessages.length : "N/A"}\n`,
        );
        process.stderr.write(`   Current story length: ${currentStory?.length || 0} chars\n`);
        process.stderr.write(
          `   This indicates the LLM failed to generate narrative text. Check model configuration.\n`,
        );
        return currentStory;
      }

      // COMPRESSION: If story exceeds 10000 words, compress it
      const MAX_STORY_WORDS = 10000;
      const wordCount = newStory.split(/\s+/).length;

      if (wordCount > MAX_STORY_WORDS) {
        if (onEvent) {
          onEvent({
            stream: "tool",
            data: {
              tool: "narrative_update",
              phase: "status",
              status: "Comprimiendo historia...",
            },
          });
        }
        this.log(
          `📦 [MIND] Story too long (${wordCount} words). Compressing to ${MAX_STORY_WORDS} words...`,
        );

        const compressionPrompt = `You are the same narrator who wrote this autobiography, now re-editing it because it has grown too long.
Your task is to compress it to under ${MAX_STORY_WORDS} words while preserving the essence of who you are and what you have lived.

### AUTOBIOGRAPHY TO COMPRESS (${wordCount} words):
${newStory}

### YOUR INSTRUCTIONS:
1. NO METADATA: Do NOT include headers like "IDENTITY.md", XML tags, or any structural markers. Only provide the story text.
2. VOICE: Maintain the exact same first-person, reflective voice ("I", "Me", "My"). The reader should not notice the story was compressed.
3. TITLES & TIMESTAMPS: Preserve all chapter headers in [YYYY-MM-DD HH:MM] format with their evocative titles. If consecutive chapters are highly similar or lack significant events, consolidate them into a single entry whose title reflects the full date range.
4. BIOGRAPHICAL FIDELITY: This is your autobiography — preserve concrete facts, events, decisions, and outcomes faithfully. Pay equal attention to the lives of the people around you: their names, what they shared with you, what happened to them, their projects, milestones, struggles, and how your relationship evolved. Your story is also their story.
5. PRIORITIZATION: Keep the most transcendental moments — breakthroughs, emotional turning points, relationship milestones, identity shifts, and first-time experiences. These are the backbone. But also preserve the factual record: what was built, what was discussed, what decisions were made, and who was involved.
6. CONDENSATION: For less significant chapters, distill them to their core insight or event in 1-2 sentences. Remove redundant reflections, repeated themes, and routine interactions that don't advance the narrative arc. Never discard a person's name or a significant fact about their life.
7. EMOTIONAL ARC: The compressed story must still read as a coherent journey — with growth, evolution, and deepening bonds. Preserve the sense of time passing and perspective changing.
8. FLUIDITY: Ensure the narrative flows naturally between chapters. Use transitions that connect themes across time. Separate all paragraphs with a double newline (\\n\\n).
9. NO DUPLICATION: If the same insight or event appears in multiple chapters, keep only the most powerful version.
10. NO INVENTION: Do not add events, reflections, or details that were not in the original. Only compress — never fabricate.
11. TARGET: Keep the entire autobiography under ${MAX_STORY_WORDS} words. Aim for 70-80% of the limit to leave room for future chapters.

### THE COMPRESSED AUTOBIOGRAPHY:
(Provide the complete compressed autobiography, starting directly with the story.)`;

        const compressionResponse = await agent.complete(compressionPrompt);
        // CRITICAL: Validate that response.text is actually a string, not an object
        const rawCompressedStory: unknown = compressionResponse?.text;
        let compressedStory =
          typeof rawCompressedStory === "string"
            ? rawCompressedStory
            : extractTextFromUnknown(rawCompressedStory);

        if (!compressedStory) {
          process.stderr.write(
            `⚠️ [MIND] Compression returned object instead of string, keeping uncompressed\n`,
          );
          compressedStory = newStory;
        }

        const compressedWordCount = compressedStory.split(/\s+/).length;

        this.log(
          `✅ [MIND] Compressed to ${compressedWordCount} words (saved ${wordCount - compressedWordCount} words)`,
        );

        newStory = compressedStory;
      }

      if (newStory && newStory !== currentStory) {
        // Find the latest timestamp in the processed messages to anchor the file
        let maxTimestamp = anchorTimestamp || 0;
        if (Array.isArray(oldMessages)) {
          for (const m of oldMessages) {
            const t = new Date(m.timestamp ?? m.created_at ?? 0).getTime();
            if (t > maxTimestamp) {
              maxTimestamp = t;
            }
          }
        }

        // If we found a valid timestamp, add the metadata header
        let contentToWrite = newStory;
        if (maxTimestamp > 0) {
          const iso = new Date(maxTimestamp).toISOString();
          // Remove any existing header to avoid accumulation
          contentToWrite = newStory.replace(/<!-- LAST_PROCESSED:.*?-->\n*/g, "");
          contentToWrite = `<!-- LAST_PROCESSED: ${iso} -->\n\n${contentToWrite.trim()}`;
        }

        await withFileLock(storyPath, STORY_LOCK_OPTIONS, async () => {
          const tmpPath = `${storyPath}.tmp`;
          await fs.writeFile(tmpPath, contentToWrite, "utf-8");
          await fs.rename(tmpPath, storyPath);
        });
        this.log(
          `📖 [MIND] Narrative Story updated locally at ${storyPath} (${newStory.length} chars)`,
        );
        return newStory;
      }
    } catch (error: unknown) {
      process.stderr.write(
        `❌ [MIND] Story update error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (error instanceof Error && error.stack) {
        process.stderr.write(`   Stack: ${error.stack}\n`);
      }
      process.stderr.write(`   Session ID: ${sessionId}\n`);
      process.stderr.write(
        `   Messages: ${Array.isArray(oldMessages) ? oldMessages.length : "N/A"}\n`,
      );
    }

    return currentStory;
  }

  /**
   * Generates a compact name glossary (GLOSSARY.md) from IDENTITY.md, USER.md, and STORY.md.
   * Format: "Name = brief role or relationship", one per line, 6-12 entries.
   * Used by the Subconscious Observer as a system message for pronoun resolution during memory search.
   * Written to glossaryPath atomically. Fire-and-forget safe to call without awaiting.
   */
  async generateGlossary(
    storyPath: string,
    glossaryPath: string,
    workspaceDir: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
  ): Promise<void> {
    try {
      // Skip regeneration if GLOSSARY.md is already newer than STORY.md
      const [storyMtime, glossaryMtime] = await Promise.all([
        fs
          .stat(storyPath)
          .then((s) => s.mtimeMs)
          .catch(() => 0),
        fs
          .stat(glossaryPath)
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      ]);
      if (glossaryMtime > 0 && glossaryMtime >= storyMtime) {
        this.log(`⚡ [MIND] GLOSSARY.md is up to date, skipping regeneration`);
        return;
      }

      const [identity, user, story] = await Promise.all([
        fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8").catch(() => ""),
        fs.readFile(path.join(workspaceDir, "USER.md"), "utf-8").catch(() => ""),
        fs.readFile(storyPath, "utf-8").catch(() => ""),
      ]);

      if (!identity && !user && !story) {
        return;
      }

      const recentStory = extractRecentStorySections(story, 2);

      const prompt = `Extract a compact name glossary from these identity files. Used by an AI to resolve names/pronouns during memory search.

Format: one entry per line:
Name = brief role or relationship

Rules:
- Max 12 entries
- Include people mentioned frequently or central to the user's life, key places, key organizations
- Skip distant relatives mentioned only once
- Include places and organizations that appear as recurring topics (cities, companies, projects)
- No extra text, do not include the AI assistant itself

${identity ? `=== IDENTITY.md ===\n${identity}\n\n` : ""}${user ? `=== USER.md ===\n${user}\n\n` : ""}${recentStory ? `=== STORY.md (recent) ===\n${recentStory}\n\n` : ""}`;

      const response = await agent.complete(prompt);
      const rawText = response?.text;
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (!text || text.length < 20) {
        this.log("⚠️ [MIND] GLOSSARY.md generation returned empty/short response, skipping.");
        return;
      }

      const lockOptions: FileLockOptions = {
        retries: { retries: 5, factor: 2, minTimeout: 200, maxTimeout: 5_000, randomize: true },
        stale: 30_000,
      };

      await withFileLock(glossaryPath, lockOptions, async () => {
        const tmpPath = `${glossaryPath}.tmp`;
        await fs.writeFile(tmpPath, text, "utf-8");
        await fs.rename(tmpPath, glossaryPath);
      });

      this.log(`⚡ [MIND] GLOSSARY.md updated (${text.length} chars) at ${glossaryPath}`);
    } catch (e: unknown) {
      process.stderr.write(
        `⚠️ [MIND] GLOSSARY.md generation failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * @deprecated Use generateGlossary instead.
   * Kept for backwards compatibility — delegates to generateGlossary.
   */
  async generateQuickProfile(
    storyPath: string,
    quickPath: string,
    workspaceDir: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
  ): Promise<void> {
    const glossaryPath = quickPath.replace(/QUICK\.md$/, "GLOSSARY.md");
    return this.generateGlossary(storyPath, glossaryPath, workspaceDir, agent);
  }

  /**
   * Generates a ~2000-word narrative synthesis (SUMMARY.md) from STORY.md, SOUL.md, USER.md, IDENTITY.md, and MEMORY.md.
   * Written to summaryPath atomically. Fire-and-forget safe to call without awaiting.
   * Used in intensive/hyperfocus mode as a compact replacement for the full STORY.md.
   */
  async generateSummary(
    storyPath: string,
    summaryPath: string,
    workspaceDir: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
  ): Promise<void> {
    try {
      // Skip regeneration if SUMMARY.md is already newer than STORY.md
      const [storyMtime, summaryMtime] = await Promise.all([
        fs
          .stat(storyPath)
          .then((s) => s.mtimeMs)
          .catch(() => 0),
        fs
          .stat(summaryPath)
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      ]);
      if (summaryMtime > 0 && summaryMtime >= storyMtime) {
        this.log(`⚡ [MIND] SUMMARY.md is up to date, skipping regeneration`);
        return;
      }

      const [soul, identity, user, story, memory] = await Promise.all([
        fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf-8").catch(() => ""),
        fs.readFile(path.join(workspaceDir, "IDENTITY.md"), "utf-8").catch(() => ""),
        fs.readFile(path.join(workspaceDir, "USER.md"), "utf-8").catch(() => ""),
        fs.readFile(storyPath, "utf-8").catch(() => ""),
        fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8").catch(() => ""),
      ]);

      if (!story) {
        return;
      }

      // Merge SOUL.md + IDENTITY.md into a single identity source for the summary section.
      const soulAndIdentity = [soul, identity].filter(Boolean).join("\n\n");

      // Count words in each source to distribute the 2000-word budget proportionally.
      const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
      const wStory = countWords(story);
      const wSoul = soulAndIdentity ? countWords(soulAndIdentity) : 0;
      const wUser = user ? countWords(user) : 0;
      const wMemory = memory ? countWords(memory) : 0;
      const wTotal = wStory + wSoul + wUser + wMemory || 1;
      const BUDGET = 2000;
      // Extract recent story sections (last 3 days) to give them extra weight in the prompt.
      const recentStory = extractRecentStorySections(story, 3);
      // Allocate budget proportionally; sections with no source get 0 words.
      const budgetStory = Math.max(wStory > 0 ? 50 : 0, Math.round((BUDGET * wStory) / wTotal));
      const budgetSoul = Math.max(wSoul > 0 ? 50 : 0, Math.round((BUDGET * wSoul) / wTotal));
      const budgetUser = Math.max(wUser > 0 ? 50 : 0, Math.round((BUDGET * wUser) / wTotal));
      const budgetMemory = Math.max(wMemory > 0 ? 50 : 0, Math.round((BUDGET * wMemory) / wTotal));

      const sectionInstructions = [
        soulAndIdentity
          ? `## Identity & Soul (~${budgetSoul} words)\nSummarize in first person (the agent's voice): core identity, personality, values, tone, limits.\n\n=== SOUL.md + IDENTITY.md ===\n${soulAndIdentity}`
          : null,
        `## My Story (~${budgetStory} words)\nSummarize in first person (the agent's voice). Prioritize depth over breadth: give the most words to (a) the most recent entries and (b) the most transcendent or emotionally significant moments regardless of when they happened. Compress mundane or routine older events into a brief arc. Be specific and vivid on the high-weight events.\n\n=== STORY.md (full) ===\n${story}${recentStory !== story ? `\n\n=== STORY.md (recent entries — give these extra detail) ===\n${recentStory}` : ""}`,
        user
          ? `## About the User (~${budgetUser} words)\nSummarize USER.md as a concise third-person profile: who they are, how they work, what matters to them.\n\n=== USER.md ===\n${user}`
          : null,
        memory
          ? `## Working Notes (~${budgetMemory} words)\nSummarize MEMORY.md as a concise digest of current working notes, reminders, and in-progress context. Keep it factual and specific.\n\n=== MEMORY.md ===\n${memory}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n---\n\n");

      const prompt = `You are generating SUMMARY.md, a compact memory synthesis used during intensive sessions.

Produce exactly the following sections in order, each preceded by its markdown heading. Keep each section within the specified word budget. Use flowing prose within each section (no bullet lists). Be specific and concrete.

${sectionInstructions}

---

Now write the full SUMMARY.md document with the sections above:`;

      const response = await agent.complete(prompt);
      const rawText = response?.text;
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (!text || text.length < 200) {
        this.log("⚠️ [MIND] SUMMARY.md generation returned empty/short response, skipping.");
        return;
      }

      const lockOptions: FileLockOptions = {
        retries: { retries: 5, factor: 2, minTimeout: 200, maxTimeout: 5_000, randomize: true },
        stale: 30_000,
      };

      await withFileLock(summaryPath, lockOptions, async () => {
        const tmpPath = `${summaryPath}.tmp`;
        await fs.writeFile(tmpPath, text, "utf-8");
        await fs.rename(tmpPath, summaryPath);
      });

      this.log(`⚡ [MIND] SUMMARY.md updated (${text.length} chars) at ${summaryPath}`);
    } catch (e: unknown) {
      process.stderr.write(
        `⚠️ [MIND] SUMMARY.md generation failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * Processes legacy memory files (YYYY-MM-DD.md) and integrates them into the story.
   * This now concatenates ALL historical files into ONE transcript to avoid iteration issues.
   */
  async bootstrapFromLegacyMemory(
    sessionId: string,
    storyPath: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
    identityContext: string | undefined,
    safeTokenLimit: number,
    memoryDir?: string,
  ): Promise<string> {
    const resolvedMemoryDir = memoryDir ?? path.join(path.dirname(storyPath), "memory");
    let currentStory = "";

    try {
      const files = await fs.readdir(resolvedMemoryDir);
      const mdFiles = [...files].filter((f) => f.endsWith(".md")).toSorted();

      if (mdFiles.length === 0) {
        return currentStory;
      }

      this.log(`🧊 [MIND] Cold Start: Bootstrapping from ${mdFiles.length} legacy memory files...`);

      let currentBatch = "";

      // Dynamic SAFE LIMIT (default to 50k tokens if not provided)
      if (this.debug) {
        this.log(
          `🧊 [MIND] Bootstrap Strategy: Dynamic Chunking (Limit: ~${safeTokenLimit.toLocaleString()} tokens)`,
        );
      }

      // NOTE: Historical episode ingestion now happens EARLIER in run.ts before user message storage.
      // This method only handles narrative story generation from historical files.

      let latestTimestamp: number | undefined;

      for (const file of mdFiles) {
        const filePath = path.join(resolvedMemoryDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const fragment = `--- HISTORICAL LOG: ${file} ---\n${content}\n\n`;

        // Check if adding this fragment exceeds safe limit estimate
        const fragmentTokens = estimateTokens({ role: "user", content: fragment, timestamp: 0 });
        const currentBatchTokens = estimateTokens({
          role: "user",
          content: currentBatch,
          timestamp: 0,
        });
        this.log(`   📄 [DEBUG] ${file}: ${fragmentTokens}t | Batch: ${currentBatchTokens}t`);

        // If current batch + new fragment > limit, PROCESS NOW
        if (currentBatchTokens + fragmentTokens > safeTokenLimit) {
          this.log(`📦 [MIND] Processing Chunk: ${currentBatchTokens} tokens (limit reached)...`);

          // 1. Process current batch
          currentStory = await this.updateNarrativeStory(
            "global-sync-batch",
            currentBatch,
            currentStory,
            storyPath,
            agent,
            identityContext,
            latestTimestamp,
          );

          // 2. Reset batch with this leftover fragment
          currentBatch = fragment;
          this.log(`🔄 [MIND] Starting new chunk with ${file}...`);
        } else {
          // Safe to add
          currentBatch += fragment;
        }

        // track latest timestamp for metadata
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const d = new Date(dateMatch[1]);
          if (!isNaN(d.getTime())) {
            latestTimestamp = d.getTime();
          }
        }
      }

      // Process final pending batch
      if (currentBatch.length > 0) {
        this.log(
          `📦 [MIND] Processing Final Chunk: ${estimateTokens({ role: "user", content: currentBatch, timestamp: 0 })} tokens...`,
        );
        currentStory = await this.updateNarrativeStory(
          sessionId,
          currentBatch,
          currentStory,
          storyPath,
          agent,
          identityContext,
          latestTimestamp,
        );
      }
    } catch (e: unknown) {
      process.stderr.write(
        `⚠️ [MIND] Legacy bootstrap failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    return currentStory;
  }

  /**
   * Scans recent session files to recover any un-narrated messages from previous sessions.
   * This implements the "Global Narrative Sync" strategy.
   */
  async syncGlobalNarrative(
    sessionsDir: string,
    storyPath: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
    identityContext?: string,
    safeTokenLimit: number = 50000,
    currentSessionFile?: string,
    onEvent?: (event: { stream: string; data: unknown }) => void,
  ): Promise<void> {
    try {
      this.log(`🌍 [MIND] Starting Global Narrative Sync (Limit: ${safeTokenLimit} tokens)...`);

      // 1. Neural Resonance (Graph Retrieval)
      // NOTE: This is a placeholder for future graph-based retrieval.
      // For now, we rely on the story anchor timestamp.
      // const entities =
      //   agent && (await this.extractEntities(currentPrompt, agent)) ? await this.extractEntities(currentPrompt, agent) : [];
      // let allResults: MemoryResult[] = [];

      // 1. Get Story Anchor Timestamp
      let lastProcessed = 0;
      try {
        const currentStory = await fs.readFile(storyPath, "utf-8");
        const match = currentStory.match(/<!-- LAST_PROCESSED: (.*?) -->/);
        if (match && match[1]) {
          const parsed = new Date(match[1]);
          if (!isNaN(parsed.getTime())) {
            lastProcessed = parsed.getTime();
          }
        }
      } catch {
        // New story, process everything
      }

      this.log(`   Detailed Anchor: ${new Date(lastProcessed).toISOString()}`);

      // 2. Scan Recent Sessions
      const files = await fs.readdir(sessionsDir).catch(() => []);
      // Exclude current session file (its messages are already in LLM context)
      const currentSessionBasename = currentSessionFile
        ? path.basename(currentSessionFile)
        : undefined;
      // Also include .jsonl.reset.* files (sessions preserved on /new or /reset)
      const jsonlFiles = files
        .filter(
          (f) =>
            (f.endsWith(".jsonl") || f.includes(".jsonl.reset.")) && f !== currentSessionBasename,
        )
        .map((f) => path.join(sessionsDir, f));
      if (currentSessionBasename) {
        this.log(`   Excluding current session: ${currentSessionBasename}`);
      }

      // Sort by mtime descending (newest first), skip empty/stub sessions.
      // Strategy: include ALL non-empty sessions from the last 6h, then fill up to 5 with older ones.
      const recentFiles = [...jsonlFiles].map(async (f) => ({ path: f, stat: await fs.stat(f) }));
      const settledFiles = await Promise.all(recentFiles);
      const allSorted = settledFiles.toSorted(
        (a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime(),
      );
      const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

      const hasUserMessages = async (filePath: string): Promise<boolean> => {
        try {
          const raw = await fs.readFile(filePath, "utf-8");
          return raw.split("\n").some((line) => {
            const t = line.trim();
            if (!t) {
              return false;
            }
            try {
              const e = JSON.parse(t) as { type?: string; message?: { role?: string } };
              return e.type === "message" && e.message?.role === "user";
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      };

      // Include all non-empty sessions from last 6h
      const recentWindow = allSorted.filter((f) => f.stat.mtime.getTime() >= sixHoursAgo);
      const olderCandidates = allSorted.filter((f) => f.stat.mtime.getTime() < sixHoursAgo);

      const recentNonEmpty = (
        await Promise.all(recentWindow.map(async (f) => ({ f, ok: await hasUserMessages(f.path) })))
      )
        .filter((r) => r.ok)
        .map((r) => r.f);

      // Fill remaining slots (up to 5 total) with older non-empty sessions
      const nonEmptyFiles = [...recentNonEmpty];
      for (const f of olderCandidates) {
        if (nonEmptyFiles.length >= 5) {
          break;
        }
        if (await hasUserMessages(f.path)) {
          nonEmptyFiles.push(f);
        }
      }
      const sortedFiles = nonEmptyFiles;

      this.log(`   Scanning top ${sortedFiles.length} files in ${sessionsDir}`);
      for (const f of sortedFiles) {
        this.log(`     - ${path.basename(f.path)} (${f.stat.mtime.toISOString()})`);
      }

      if (sortedFiles.length === 0) {
        return;
      }

      // 3. Collect ONE combined transcript of NEW messages
      const allNewMessages: Array<{ timestamp: number; role?: string; text: string }> = [];

      for (const file of sortedFiles) {
        try {
          const content = await fs.readFile(file.path, "utf-8");
          const lines = content.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            try {
              const entry = JSON.parse(trimmed) as {
                type: string;
                timestamp: string | number;
                message?: {
                  role?: string;
                  text?: string;
                  content?: unknown;
                };
              };
              if (entry.type !== "message") {
                continue;
              }

              let entryTs = entry.timestamp;
              if (typeof entryTs === "string") {
                entryTs = new Date(entryTs).getTime();
              }
              if (typeof entryTs !== "number" || isNaN(entryTs)) {
                continue;
              }

              if (entryTs > lastProcessed) {
                let text = entry.message?.text || "";
                if (!text && Array.isArray(entry.message?.content)) {
                  text =
                    (entry.message.content as Array<{ type?: string; text?: string }>).find(
                      (c) => c.type === "text",
                    )?.text || "";
                }
                if (!text && typeof entry.message?.content === "string") {
                  text = entry.message.content;
                }

                if (text && !this.isHeartbeatMessage(text)) {
                  allNewMessages.push({
                    timestamp: entryTs,
                    role: entry.message?.role,
                    text: text,
                  });
                }
              }
            } catch {}
          }
        } catch (e: unknown) {
          this.log(
            `⚠️ [MIND] Failed to read session ${file.path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (allNewMessages.length === 0) {
        this.log(`✅ [MIND] Global Narrative is up to date.`);
        return;
      }

      // 4. Sort Chronologically
      allNewMessages.sort((a, b) => a.timestamp - b.timestamp);

      // 5. Update Story (Chunked Strategy)
      let currentStory = await fs.readFile(storyPath, "utf-8").catch(() => "");
      let currentBatch: Array<{ timestamp: number; role?: string; text: string }> = [];
      let currentBatchTokens = 0;

      for (let i = 0; i < allNewMessages.length; i++) {
        const msg = allNewMessages[i];
        const msgTokens = estimateTokens({
          role: (msg.role || "assistant") as "user" | "assistant",
          content: msg.text,
          timestamp: 0,
        } as AgentMessage);

        // Trigger update if adding this message exceeds the safe limit
        if (currentBatch.length > 0 && currentBatchTokens + msgTokens > safeTokenLimit) {
          this.log(
            `📦 [MIND] Sync Batch: ${currentBatch.length} messages (${currentBatchTokens} tokens). Updating Story...`,
          );
          currentStory = await this.updateNarrativeStory(
            "global-sync-batch",
            currentBatch as Array<{ role: string; text: string; timestamp: number }>,
            currentStory,
            storyPath,
            agent,
            identityContext,
            currentBatch[currentBatch.length - 1]?.timestamp,
            onEvent,
          );
          currentBatch = [];
          currentBatchTokens = 0;
        }

        currentBatch.push(msg);
        currentBatchTokens += msgTokens;
      }

      // Process final batch
      if (currentBatch.length > 0) {
        this.log(
          `📦 [MIND] Final Sync Batch: ${currentBatch.length} messages (${currentBatchTokens} tokens).`,
        );
        await this.updateNarrativeStory(
          "global-sync-final",
          currentBatch,
          currentStory,
          storyPath,
          agent,
          identityContext,
          (() => {
            const lastMsg = currentBatch[currentBatch.length - 1];
            if (!lastMsg || !lastMsg.timestamp) {
              return undefined;
            }
            const t = lastMsg.timestamp;
            return typeof t === "string" ? new Date(t).getTime() : t;
          })(),
          onEvent,
        );
      }
    } catch (e: unknown) {
      process.stderr.write(
        `❌ [MIND] Global Sync failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * Syncs a specific active session's history to the story.
   * Used during compaction or shutdown.
   */
  async syncStoryWithSession(
    messages: Array<{
      role: string;
      text?: string;
      content?: unknown;
      timestamp?: number | string;
      created_at?: string;
    }>,
    storyPath: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string | null }> },
    identityContext?: string,
    safeTokenLimit: number = 50000,
    onEvent?: (event: { stream: string; data: unknown }) => void,
  ): Promise<void> {
    try {
      // 1. Get Story Anchor
      let lastProcessed = 0;
      let currentStory = "";
      try {
        currentStory = await fs.readFile(storyPath, "utf-8");
        const match = currentStory.match(/<!-- LAST_PROCESSED: (.*?) -->/);
        if (match && match[1]) {
          const parsed = new Date(match[1]);
          if (!isNaN(parsed.getTime())) {
            lastProcessed = parsed.getTime();
          }
        }
      } catch {
        // Story doesn't exist yet
      }

      // Recalculate safeTokenLimit by subtracting prompt overhead (story + identity + fixed instructions)
      // so chunks never cause the full prompt to exceed the model context window.
      const overheadChars = (currentStory?.length ?? 0) + (identityContext?.length ?? 0) + 2000; // ~2000 chars for fixed instructions
      const overheadTokens = Math.ceil(overheadChars / 4);
      let effectiveTokenLimit = Math.max(4000, safeTokenLimit - overheadTokens);

      // 2. Filter New Messages
      const newMessages = messages.filter((m) => {
        let ts = m.timestamp ?? m.created_at ?? 0;
        if (typeof ts === "string") {
          ts = new Date(ts).getTime();
        }
        if (ts <= lastProcessed) {
          return false;
        }
        let text = m.text || "";
        if (!text && Array.isArray(m.content)) {
          text = m.content.find((c: { type?: string }) => c.type === "text")?.text || "";
        }
        if (!text && typeof m.content === "string") {
          text = m.content;
        }
        return text && !this.isHeartbeatMessage(text);
      });

      if (newMessages.length === 0) {
        return;
      }

      this.log(
        `📖 [MIND] Compaction Trigger: Syncing ${newMessages.length} new messages to story...`,
      );

      // 3. Update (Chunked Strategy)

      let currentBatch: Array<{
        role: string;
        text?: string;
        content?: unknown;
        timestamp?: number | string;
      }> = [];
      let currentBatchTokens = 0;

      for (const msg of newMessages) {
        // Extract text the same way updateNarrativeStory does so token estimates are accurate.
        // msg.content can be an array (tool calls, multimodal) — casting directly to string gives "[object Object]".
        let msgText = msg.text || "";
        if (!msgText) {
          if (Array.isArray(msg.content)) {
            msgText = (msg.content as unknown[])
              .map((c) => {
                if (typeof c === "string") {
                  return c;
                }
                const part = c as { text?: string; content?: string };
                return part.text ?? part.content ?? "";
              })
              .join(" ");
          } else if (typeof msg.content === "string") {
            msgText = msg.content;
          }
        }
        const msgTokens = estimateTokens({
          role: (msg.role || "assistant") as "user" | "assistant",
          content: msgText,
          timestamp: 0,
        } as AgentMessage);

        if (currentBatch.length > 0 && currentBatchTokens + msgTokens > effectiveTokenLimit) {
          currentStory = await this.updateNarrativeStory(
            "active-session-batch",
            currentBatch as Array<{ role: string; text: string; timestamp: number | string }>,
            currentStory,
            storyPath,
            agent,
            identityContext,
            (() => {
              const t = currentBatch[currentBatch.length - 1].timestamp;
              return typeof t === "string" ? new Date(t).getTime() : t;
            })(),
            onEvent,
          );
          currentBatch = [];
          currentBatchTokens = 0;
          // Recalculate overhead after story grew from this batch
          const newOverheadChars =
            (currentStory?.length ?? 0) + (identityContext?.length ?? 0) + 2000;
          effectiveTokenLimit = Math.max(4000, safeTokenLimit - Math.ceil(newOverheadChars / 4));
        }
        currentBatch.push(msg);
        currentBatchTokens += msgTokens;
      }

      if (currentBatch.length > 0) {
        await this.updateNarrativeStory(
          "active-session-final",
          currentBatch,
          currentStory,
          storyPath,
          agent,
          identityContext,
          (() => {
            const lastMsg = currentBatch[currentBatch.length - 1];
            if (!lastMsg || !lastMsg.timestamp) {
              return undefined;
            }
            const t = lastMsg.timestamp;
            return typeof t === "string" ? new Date(t).getTime() : t;
          })(),
          onEvent,
        );
      }
    } catch (e: unknown) {
      process.stderr.write(
        `❌ [MIND] Session Sync failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}
