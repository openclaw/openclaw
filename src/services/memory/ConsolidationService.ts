import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { getRelativeTimeDescription } from "../../utils/time-format.js";
import { GraphService } from "./GraphService.js";
import { buildStoryPrompt } from "./story-prompt-builder.js";

// File-based lock to prevent concurrent narrative syncs across separate Node processes
const NARRATIVE_LOCK_FILE = "/tmp/mind_narrative_sync.lock";
const NARRATIVE_LOCK_MAX_AGE_MS = 120_000; // 2 minutes (stale lock detection)

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
   * Bootstrap historical episodes into Graphiti if the graph is empty.
   * This should be called BEFORE flashback retrieval to ensure historical context is available.
   */
  async bootstrapHistoricalEpisodes(
    sessionId: string,
    memoryDir: string,
    sessionMessages: Array<{
      role?: string;
      text?: string;
      content?: unknown;
      timestamp?: unknown;
      created_at?: unknown;
    }> = [],
  ): Promise<void> {
    try {
      // Check if bootstrap has already been done using a flag file
      const bootstrapFlagPath = path.join(memoryDir, ".graphiti-bootstrap-done");

      try {
        await fs.access(bootstrapFlagPath);
        return;
      } catch {
        // Continue to bootstrap
      }

      this.log(`📥 [MIND] No bootstrap flag found. Ingesting memory history into Graphiti...`);

      // 1. Ingest Historical MD Files
      const files = await fs.readdir(memoryDir);
      const mdFiles = files.filter((f) => f.endsWith(".md")).toSorted();

      for (const file of mdFiles) {
        const filePath = path.join(memoryDir, file);
        const content = await fs.readFile(filePath, "utf-8");

        let episodeTimestamp: string | undefined;
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const d = new Date(dateMatch[1]);
          if (!isNaN(d.getTime())) {
            d.setHours(23, 59, 59, 999);
            episodeTimestamp = d.toISOString();
          }
        }

        const dateString = episodeTimestamp || file.substring(0, 10);
        await this.graph.addEpisode(
          "global-user-memory", // FORCE GLOBAL ID for historical files
          `FECHA: ${dateString} | system: Historical memory from ${file}\n\n${content}`,
          episodeTimestamp,
          { source: "historical-file" },
        );
      }

      // 2. Ingest Active Session Messages as a SINGLE Transcript Episode (Optimization)
      if (sessionMessages.length > 0) {
        this.log(
          `📥 [MIND] Ingesting ${sessionMessages.length} previous turns as a single transcript batch...`,
        );

        const transcriptLines: string[] = [];
        let earliestDate = new Date();

        for (const m of sessionMessages) {
          const role = m.role || "unknown";
          let text = m.text || m.content || "";
          if (Array.isArray(text)) {
            text = text
              .map((p: unknown) =>
                typeof p === "string" ? p : (p as { text?: string }).text || "",
              )
              .join(" ");
          }
          if (!text) {
            continue;
          }

          const ts = (m.timestamp || m.created_at) as string | number | Date;
          const date = ts ? new Date(ts) : new Date();
          if (date < earliestDate) {
            earliestDate = date;
          }

          const timeStr = date.toISOString().split("T")[1].substring(0, 5);

          if (this.isHeartbeatMessage(text as string)) {
            continue;
          }

          const textStr = typeof text === "string" ? text : JSON.stringify(text);
          transcriptLines.push(`[${timeStr}] ${role}: ${textStr}`);
        }

        if (transcriptLines.length > 0) {
          const earliestIso = earliestDate.toISOString();
          const transcriptBody = `FECHA: ${earliestIso} | [TRANSCRIPCIÓN DE SESIÓN]\n${transcriptLines.join("\n")}`;

          await this.graph.addEpisode("global-user-memory", transcriptBody, earliestIso, {
            source: "message",
          });
        }
      }

      await fs.writeFile(bootstrapFlagPath, new Date().toISOString());
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
  ): Promise<string> {
    if (typeof oldMessages !== "string" && oldMessages.length === 0) {
      return currentStory;
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

    try {
      const response = await agent.complete(prompt);
      const rawStory = response?.text || "";

      // DEBUG: Log first 300 chars - REMOVED PER USER REQUEST

      // Use the complete generated story directly
      let newStory = rawStory;

      // COMPRESSION: If story exceeds 10000 words, compress it
      const MAX_STORY_WORDS = 10000;
      const wordCount = newStory.split(/\s+/).length;

      if (wordCount > MAX_STORY_WORDS) {
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
        const compressedStory = compressionResponse?.text || newStory;
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

        const tmpPath = `${storyPath}.tmp`;
        await fs.writeFile(tmpPath, contentToWrite, "utf-8");
        await fs.rename(tmpPath, storyPath);
        this.log(
          `📖 [MIND] Narrative Story updated locally at ${storyPath} (${newStory.length} chars)`,
        );
        return newStory;
      }
    } catch (error: unknown) {
      process.stderr.write(
        `❌ [MIND] Story update error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }

    return currentStory;
  }

  /**
   * Processes legacy memory files (YYYY-MM-DD.md) and integrates them into the story.
   * This now concatenates ALL historical files into ONE transcript to avoid iteration issues.
   */
  private async bootstrapFromLegacyMemory(
    sessionId: string,
    storyPath: string,
    agent: { complete: (prompt: string) => Promise<{ text?: string }> },
    identityContext: string | undefined,
    safeTokenLimit: number,
  ): Promise<string> {
    const memoryDir = path.join(path.dirname(storyPath), "memory");
    let currentStory = "";

    try {
      const files = await fs.readdir(memoryDir);
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
        const filePath = path.join(memoryDir, file);
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
    agent: { complete: (prompt: string) => Promise<{ text?: string }> },
    identityContext?: string,
    safeTokenLimit: number = 50000,
    currentSessionFile?: string,
  ): Promise<void> {
    try {
      // Guard: file-based lock to prevent concurrent syncs across processes
      try {
        const lockStat = await fs.stat(NARRATIVE_LOCK_FILE);
        const lockAge = Date.now() - lockStat.mtimeMs;
        if (lockAge < NARRATIVE_LOCK_MAX_AGE_MS) {
          this.log(
            `⏭️ [MIND] Global Narrative Sync already in progress (lock age: ${Math.round(lockAge / 1000)}s) - skipping.`,
          );
          return;
        }
        // Lock is stale (>2min), process probably crashed - take over
        this.log(
          `⚠️ [MIND] Stale narrative lock detected (${Math.round(lockAge / 1000)}s old) - taking over.`,
        );
      } catch {
        // Lock file doesn't exist - we're clear to proceed
      }

      // Acquire lock
      await fs.writeFile(
        NARRATIVE_LOCK_FILE,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );

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
      const jsonlFiles = files
        .filter((f) => f.endsWith(".jsonl") && f !== currentSessionBasename)
        .map((f) => path.join(sessionsDir, f));
      if (currentSessionBasename) {
        this.log(`   Excluding current session: ${currentSessionBasename}`);
      }

      // Sort by mtime descending (newest first) and take top 5
      const recentFiles = [...jsonlFiles].map(async (f) => ({ path: f, stat: await fs.stat(f) }));
      const settledFiles = await Promise.all(recentFiles);
      const sortedFiles = settledFiles
        .toSorted((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime())
        .slice(0, 5);

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
        );
      }
    } catch (e: unknown) {
      process.stderr.write(
        `❌ [MIND] Global Sync failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    } finally {
      // Release file lock
      try {
        await fs.unlink(NARRATIVE_LOCK_FILE);
      } catch {}
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
    agent: { complete: (prompt: string) => Promise<{ text?: string }> },
    identityContext?: string,
    safeTokenLimit: number = 50000,
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
        const msgTokens = estimateTokens({
          role: (msg.role || "assistant") as "user" | "assistant",
          content: String(msg.text || (msg.content as string) || ""),
          timestamp: 0,
        } as AgentMessage);

        if (currentBatch.length > 0 && currentBatchTokens + msgTokens > safeTokenLimit) {
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
          );
          currentBatch = [];
          currentBatchTokens = 0;
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
        );
      }
    } catch (e: unknown) {
      process.stderr.write(
        `❌ [MIND] Session Sync failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}
