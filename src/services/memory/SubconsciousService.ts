import { performance } from "node:perf_hooks";
import { getRelativeTimeDescription } from "../../utils/time-format.js";
import { GraphService, type MemoryResult } from "./GraphService.js";

export interface LLMClient {
  complete(prompt: string, systemPrompt?: string): Promise<{ text: string | null }>;
}

export interface RecentMessage {
  role: string;
  text?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

export class SubconsciousService {
  private graph: GraphService;
  private recentlyRecalled: Set<string> = new Set();
  private maxEchoFilterSize = 25;
  private debug: boolean;

  constructor(graph: GraphService, debug: boolean = false) {
    this.graph = graph;
    this.debug = debug;
  }

  private log(message: string) {
    if (this.debug) {
      process.stderr.write(`${message}\n`);
    }
  }

  /**
   * Atomic Repetition Truncator:
   * Detects immediate verbatim repetitions of 8+ characters to kill LLM loops.
   */
  private truncateRepetitive(text: string): string {
    for (let len = Math.floor(text.length / 2); len >= 3; len--) {
      for (let i = 0; i <= text.length - 2 * len; i++) {
        const chunk = text.substring(i, i + len);
        const next = text.substring(i + len, i + 2 * len);
        if (chunk === next && chunk.trim().length >= 3) {
          return text.substring(0, i + len);
        }
      }
    }
    return text;
  }

  /**
   * The Observer & The Seeker:
   * Analyzes recent messages to identify themes and generate optimized search queries.
   */
  async generateSeekerQueries(
    currentPrompt: string,
    recentMessages: RecentMessage[],
    agent?: LLMClient,
    quickContext?: string,
  ): Promise<string[]> {
    // Strip "Conversation info (untrusted metadata)" JSON blocks if present
    const cleanedPrompt = currentPrompt
      .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/g, "")
      .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```/g, "")
      .replace(/^🎙️?\s*(?:\(De [^)]+\):)?\s*/m, "")
      .trim();

    if (!agent) {
      this.log(`  👁️ [OBSERVER] No agent available, using naive keyword extraction.`);
      return [
        cleanedPrompt
          .split(/\s+/)
          .filter((w) => w.length > 5)
          .slice(0, 3)
          .join(" "),
      ];
    }

    const analysisWindow = recentMessages.slice(-8);

    // If no history, skip LLM and use prompt keywords directly
    if (analysisWindow.length === 0) {
      this.log(`  👁️ [OBSERVER] No history — using prompt keywords directly.`);
      const words = cleanedPrompt.split(/\s+/).filter((w) => w.length > 4);
      return words.length > 0 ? [words.slice(0, 5).join(" ")] : [cleanedPrompt.substring(0, 80)];
    }

    const historyLines = analysisWindow
      .map((m) => {
        let mText = m.text || m.content || "";
        if (Array.isArray(mText)) {
          mText = mText.map((p) => (typeof p === "string" ? p : p.text || "")).join(" ");
        }
        const raw = String(mText);

        // Extract sender name from Telegram metadata block or MindFace prefix
        const metaSenderMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
        const mindfaceMatch = raw.match(/^🎙️?\s*\(De ([^)]+)\)/);
        const displayRole =
          m.role === "assistant" ? "Mind" : (metaSenderMatch?.[1] ?? mindfaceMatch?.[1] ?? m.role);

        // Strip Telegram/MindFace metadata blocks and MindFace prefix
        const cleaned = raw
          .replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```/g, "")
          .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```/g, "")
          .replace(/^🎙️?\s*(?:\(De [^)]+\):)?\s*/m, "")
          .trim();
        return cleaned ? `${displayRole}: ${cleaned}` : null;
      })
      .filter(Boolean) as string[];

    // If everything cleaned away, or only assistant messages (no user input), skip LLM
    const hasUserTurn =
      analysisWindow.some((m) => m.role === "user") ||
      historyLines.some((l) => !l.startsWith("Mind:"));
    if (historyLines.length === 0 || !hasUserTurn) {
      this.log(`  👁️ [OBSERVER] History empty or assistant-only — using prompt keywords directly.`);
      const words = cleanedPrompt.split(/\s+/).filter((w) => w.length > 4);
      return words.length > 0 ? [words.slice(0, 5).join(" ")] : [cleanedPrompt.substring(0, 80)];
    }

    const historyText = historyLines.join("\n");

    const userPrompt = `3 short English keyword phrases (2-5 words each) to search past memories. One per line, nothing else.

CONVERSATION:
${historyText}

LATEST MESSAGE: "${cleanedPrompt}"

Use ONLY names, events, topics from the conversation. If the latest message is a short reaction, use the conversation substance instead. No bullets, no numbers, no explanations.`;

    this.log(`  👁️ [OBSERVER] Performing entity resolution and generating search queries...`);

    const glossarySystem = quickContext?.trim()
      ? `You generate memory search phrases. ONLY output 3 short keyword phrases, one per line. NEVER list, repeat or quote the name reference below.\nName reference: ${quickContext.trim().split("\n").join(" | ")}`
      : undefined;

    try {
      const response = await agent.complete(userPrompt, glossarySystem);
      let rawOutput = (response?.text || "").trim();

      rawOutput = this.truncateRepetitive(rawOutput);

      const lines = rawOutput
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 3);

      const queries: string[] = [];
      const seenQueries = new Set<string>();

      for (const line of lines) {
        if (queries.length >= 3) {
          break;
        }

        const clean = line
          .replace(/^[-*•\d.]+\s*/, "")
          .replace(/["']/g, "")
          .trim();
        if (clean.length < 3) {
          continue;
        }
        // Discard lines that look like glossary echoes
        if (
          // "Name = role" entry format
          (clean.includes(" = ") && clean.split(" = ").length === 2) ||
          // Single-line dump with multiple "|" separators
          (clean.split(" | ").length >= 3 && clean.includes(" = ")) ||
          // Bare AI name with no other content
          clean === "Mind Tercero Roldán"
        ) {
          continue;
        }

        const normalized = clean.toLowerCase();
        if (!seenQueries.has(normalized)) {
          seenQueries.add(normalized);
          queries.push(clean);
        }
      }

      if (queries.length === 0) {
        queries.push(cleanedPrompt.substring(0, 150));
      }

      return queries;
    } catch (e) {
      this.log(`  ❌ [OBSERVER] Error generating queries: ${String(e)}`);
      return [cleanedPrompt.substring(0, 50)];
    }
  }

  /**
   * The Echo Filter:
   * Prevents repeating the same memories too frequently.
   */
  private applyEchoFilter(results: MemoryResult[]): MemoryResult[] {
    const beforeCount = results.length;
    const filtered = results.filter((r) => {
      if (r._boosted) {
        return true;
      }
      const id = r.message?.uuid || r.uuid || JSON.stringify(r.text || r.content);
      return !this.recentlyRecalled.has(id);
    });

    const blockedCount = beforeCount - filtered.length;
    if (blockedCount > 0) {
      this.log(`  🔇 [ECHO] Blocked ${blockedCount} redundant memories.`);
    }

    filtered.forEach((r) => {
      const id = r.message?.uuid || r.uuid || JSON.stringify(r.text || r.content);
      this.recentlyRecalled.add(id);
    });

    if (this.recentlyRecalled.size > this.maxEchoFilterSize) {
      const items = Array.from(this.recentlyRecalled);
      this.recentlyRecalled = new Set(items.slice(-this.maxEchoFilterSize));
    }

    return filtered;
  }

  /**
   * The Memory Horizon:
   * Ensures flashbacks are older than the messages currently in the context.
   */
  private applyMemoryHorizon(
    results: MemoryResult[],
    oldestContextTimestamp?: Date,
  ): MemoryResult[] {
    if (!oldestContextTimestamp) {
      return results;
    }

    this.log(`  🌅 [HORIZON] Threshold: ${oldestContextTimestamp.toISOString()}`);
    const beforeCount = results.length;
    const filtered = results.filter((r) => {
      const content = r.message?.content || r.text || r.content || "";
      const dateTagMatch = content.match(
        /(?:Ocurrido el|memory log for|FECHA:|DATE:)\s*(\d{4}-\d{2}-\d{2})/i,
      );

      let timestamp: string | Date | undefined =
        r.message?.created_at || r.message?.createdAt || r.timestamp;

      if (dateTagMatch) {
        timestamp = dateTagMatch[1];
      } else {
        const tsMatch = content.match(/\[TIMESTAMP:([^\]]+)\]/);
        if (tsMatch) {
          timestamp = tsMatch[1];
        }
      }

      if (!timestamp) {
        return true;
      }
      const memoryDate = new Date(timestamp);
      if (isNaN(memoryDate.getTime())) {
        return true;
      }

      return memoryDate.getTime() < oldestContextTimestamp.getTime();
    });

    const filteredCount = beforeCount - filtered.length;
    if (filteredCount > 0) {
      this.log(`  🌅 [HORIZON] Blocked ${filteredCount} memories newer than conversation context.`);
    }
    return filtered;
  }

  async getFlashback(
    sessionId: string | string[],
    currentPrompt: string,
    agent: LLMClient | null,
    oldestContextTimestamp?: Date,
    recentMessages: RecentMessage[] = [],
    soulContext?: string,
    storyContext?: string,
    rewriteMemories: boolean = true,
    /** Dedicated agent for observer query generation — should have no thinking for low latency. Falls back to agent. */
    observerAgent?: LLMClient | null,
    onEvent?: (event: { stream: string; data: unknown }) => void,
  ): Promise<string> {
    if (onEvent) {
      onEvent({
        stream: "tool",
        data: {
          tool: "subconscious",
          phase: "call",
        },
      });
    }
    this.log("🧠 [MIND] Subconscious is exploring memories...");
    const startTime = performance.now();

    const t0 = performance.now();
    if (onEvent) {
      onEvent({
        stream: "tool",
        data: {
          tool: "subconscious",
          phase: "status",
          status: "Buscando recuerdos...",
        },
      });
    }
    const searchQueries = await this.generateSeekerQueries(
      currentPrompt,
      recentMessages,
      observerAgent ?? agent ?? undefined,
      storyContext,
    );
    const t_queries = performance.now() - t0;

    let allResults: MemoryResult[] = [];
    const seenUris = new Set<string>();

    this.log(`  📊 [MIND] Executing ${searchQueries.length} semantic queries in parallel...`);

    const t1 = performance.now();
    // Execute all queries in parallel
    const parallelResults = await Promise.all(
      searchQueries.map(async (query) => {
        const facts = await this.graph.searchFacts(sessionId, query);
        return { query, facts };
      }),
    );

    for (const { query, facts } of parallelResults) {
      this.log(`    ✅ [GRAPH] Query "${query}": Found ${facts.length} facts.`);
      let addedForQuery = 0;
      for (const res of facts) {
        if (addedForQuery >= 3) {
          break;
        }
        const id = res.message?.uuid || res.uuid || res.content;
        if (id && !seenUris.has(id)) {
          allResults.push(res);
          seenUris.add(id);
          addedForQuery++;
        }
      }
    }

    if (allResults.length === 0) {
      this.log("💤 [MIND] No relevant memories found.");
      return "";
    }

    this.log(
      `  ✅ [GRAPH] Found ${allResults.length} potential memories across ${searchQueries.length} queries.`,
    );

    const afterHorizon = this.applyMemoryHorizon(allResults, oldestContextTimestamp);
    const afterEcho = this.applyEchoFilter(afterHorizon);

    if (afterEcho.length === 0) {
      this.log("🔍 [MIND] No relevant flashbacks found after filtering.");
      return "";
    }

    // Sort: Boosted > Facts > Time parity (to mix old/new)
    afterEcho.sort((a, b) => {
      if (a._boosted && !b._boosted) {
        return -1;
      }
      if (!a._boosted && b._boosted) {
        return 1;
      }

      const aIsFact = a._sourceQuery?.toLowerCase().includes("fact") ?? false;
      const bIsFact = b._sourceQuery?.toLowerCase().includes("fact") ?? false;
      if (aIsFact && !bIsFact) {
        return -1;
      }
      if (!aIsFact && bIsFact) {
        return 1;
      }

      const aTs = new Date(
        a.timestamp || a.message?.created_at || a.message?.createdAt || 0,
      ).getTime();
      const bTs = new Date(
        b.timestamp || b.message?.created_at || b.message?.createdAt || 0,
      ).getTime();
      return Math.random() > 0.5 ? aTs - bTs : bTs - aTs;
    });

    const groupedMemories = new Map<
      string,
      Array<{ content: string; date: Date; relativeTime: string; isFact: boolean }>
    >();
    const groupMaxScore = new Map<string, number>();
    const seenContent = new Set<string>();
    let totalSelected = 0;

    for (const r of afterEcho) {
      if (totalSelected >= 10) {
        break;
      } // Increased total limit to allow grouping from multiple queries

      let content = r.message?.content || r.text || r.content || "";
      content = content.replace(/\[TIMESTAMP:[^\]]+\]/g, "").trim();

      if (content.startsWith("{") && content.endsWith("}")) {
        this.log(`  🚫 [MIND] Skipping JSON content: ${content.substring(0, 80)}`);
        continue;
      }

      const normalized = content
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .substring(0, 30);
      if (!normalized || seenContent.has(normalized)) {
        this.log(`  🚫 [MIND] Skipping duplicate/empty content: "${content.substring(0, 60)}"`);
        continue;
      }
      seenContent.add(normalized);

      const finalDate = new Date(
        r.timestamp || r.message?.created_at || r.message?.createdAt || Date.now(),
      );
      const relativeTime = getRelativeTimeDescription(finalDate);
      const isFact = r._sourceQuery?.toLowerCase().includes("fact") ?? false;
      const queryGroup = r._sourceQuery || "General Context";

      if (!groupedMemories.has(queryGroup)) {
        groupedMemories.set(queryGroup, []);
      }
      groupedMemories.get(queryGroup)!.push({ content, date: finalDate, relativeTime, isFact });

      // Track max score per group for ranking
      if (r._score !== undefined) {
        const prev = groupMaxScore.get(queryGroup) ?? 0;
        if (r._score > prev) {
          groupMaxScore.set(queryGroup, r._score);
        }
      }

      totalSelected++;
    }

    // Re-order groups by score descending (best match first for top-block injection)
    const sortedGroups = Array.from(groupedMemories.entries()).toSorted(([aKey], [bKey]) => {
      const aScore = groupMaxScore.get(aKey) ?? 0;
      const bScore = groupMaxScore.get(bKey) ?? 0;
      return bScore - aScore;
    });

    // Log group scores for visibility
    for (const [group, _] of sortedGroups) {
      const score = groupMaxScore.get(group);
      const label = score !== undefined ? `score=${score.toFixed(3)}` : "score=n/a";
      this.log(`  📊 [RANK] Group "${group}" → ${label}`);
    }

    const t_search = performance.now() - t1;

    if (onEvent) {
      onEvent({
        stream: "tool",
        data: {
          tool: "subconscious",
          phase: "status",
          status: "Resonando con el pasado...",
        },
      });
    }

    let rewrittenLines = "";
    const t2 = performance.now();
    if (agent && rewriteMemories) {
      this.log(`  ✍️ [MIND] Rewriting ${sortedGroups.length} memory groups in parallel...`);

      const rewritePromises = sortedGroups.map(async ([query, memories]) => {
        // Clean up the query string for display
        let displayQuery = query;
        const match = query.match(/\((.*?)\)/);
        if (match && match[1]) {
          displayQuery = match[1].replace(/\.\.\.$/, "");
        }

        const groupHeader = `--- PENSAR EN "${displayQuery}" ME RECUERDA QUE ---`;
        const groupLines: string[] = [groupHeader];

        // Sort chronologically within the group
        memories.sort((a, b) => a.date.getTime() - b.date.getTime());

        for (const m of memories) {
          if (m.isFact) {
            this.log(`  ✨ [FINAL] Adding Fact to Resonance: "${m.content.substring(0, 60)}..."`);
          }
          groupLines.push(`- [${m.relativeTime}] ${m.content}`);
        }

        const translationPrompt = `Convert the following database notes into personal, first-person memories for a specific search topic.
You are the AI. subconsciously remembering your past interactions with the user.
CRITICAL: Write the memories in the EXACT SAME LANGUAGE as the CURRENT USER MESSAGE below.

FORMATTING RULES:
1. Preserve the grouping header: "${groupHeader}" but translate the header into a natural transition, like "${displayQuery} reminds me that..." or "Thinking about ${displayQuery}, I remember...".
2. Under the header, rewrite the memories as a bulleted list format, one memory per line.
3. The raw memories include fuzzy relative timestamps like [hace 2 semanas] or [yesterday morning]. Incorporate them naturally into each sentence rather than keeping them as bracketed labels.

AS SUBCONCIOUS AI, FOLLOW THESE STRICT CONTENT RULES — NEVER break these:
1. DO NOT REPLY TO THE USER. DO NOT ADD CONVERSATIONAL RESPONSES. ONLY OUTPUT THE HEADER AND THE BULLETED MEMORIES.
2. Do NOT invent or infer ANY fact, action, method, or context that is not EXPLICITLY stated in the RAW MEMORIES below.
3. Do NOT add sensory details like "I heard", "I saw", "I felt" unless that is literally written in the source.
4. If the source says "the user spoke", write "the user spoke" — do NOT say "I heard you speak".
5. Only rephrase style and point-of-view (1st person). Keep ALL facts strictly sourced from the raw text.

${soulContext ? `\n=== YOUR UNIQUE PERSONA (SOUL) ===\n${soulContext}\n` : ""}${storyContext ? `\n=== YOUR ONGOING NARRATIVE (STORY) ===\n${storyContext}\n` : ""}
CURRENT USER MESSAGE (Detect language from this):
"${currentPrompt}"

RAW MEMORIES:
${groupLines.join("\n")}`;

        try {
          const res = await agent.complete(translationPrompt);
          if (res.text?.trim()) {
            // Strictly keep ONLY lines that are headers or list items
            return res.text
              .split("\n")
              .filter((l) => {
                const trimmed = l.trim();
                return (
                  trimmed.startsWith("-") ||
                  trimmed.startsWith("*") ||
                  trimmed.startsWith("•") ||
                  trimmed.startsWith("---") ||
                  trimmed.toLowerCase().includes("reminds me") ||
                  trimmed.toLowerCase().includes("recuerda que")
                );
              })
              .join("\n");
          }
        } catch (e) {
          this.log(`  ❌ [MIND] Error rewriting group "${displayQuery}": ${String(e)}`);
        }

        // Fallback to raw lines if LLM fails
        return groupLines.join("\n");
      });

      const rewrittenGroups = await Promise.all(rewritePromises);
      rewrittenLines = rewrittenGroups.filter((text) => text.trim().length > 0).join("\n\n");
      this.log(`  ✅ [MIND] Parallel rewriting completed successfully.`);
    } else {
      // Deterministic Fallback if LLM rewriting is disabled
      this.log(`  ⚡ [MIND] Rewriting disabled. Using programmatic fast-formatting...`);
      const rawLines: string[] = [];
      for (const [query, memories] of sortedGroups) {
        // 1. Clean up the query string
        let displayQuery = query;
        const match = query.match(/\((.*?)\)/);
        if (match && match[1]) {
          displayQuery = match[1].replace(/\.\.\.$/, "");
        }

        // 2. Natural programmatic transition
        rawLines.push(`---`);
        rawLines.push(`* Thinking about "${displayQuery}" reminds me that:`);

        // 3. Chronological sorting
        memories.sort((a, b) => a.date.getTime() - b.date.getTime());

        // 4. Formatting bullets with relative time
        for (const m of memories) {
          if (m.isFact) {
            this.log(`  ✨ [FINAL] Adding Fact to Resonance: "${m.content.substring(0, 60)}..."`);
          }
          rawLines.push(`  - [${m.relativeTime}] ${m.content}`);
        }
      }
      rewrittenLines = rawLines.join("\n");
    }
    const t_rewrite = performance.now() - t2;
    const totalTime = performance.now() - startTime;

    const finalResonance = `\n---\n[SUBCONSCIOUS RESONANCE]\n${rewrittenLines}\n---\n`;

    // Always log the final resonance block for visibility
    process.stderr.write(`\n ================================================ `);
    process.stderr.write(`\n🧠 [MIND] DRIFTING INTO RESONANCE: \n${finalResonance} `);
    process.stderr.write(
      `⏱️  [LATENCY] Total: ${totalTime.toFixed(0)}ms (Queries: ${t_queries.toFixed(0)}ms, Search: ${t_search.toFixed(0)}ms, Rewrite: ${t_rewrite.toFixed(0)}ms)\n`,
    );
    process.stderr.write(`================================================\n`);

    if (onEvent) {
      onEvent({
        stream: "tool",
        data: {
          tool: "subconscious",
          phase: "result",
        },
      });
    }

    return finalResonance;
  }
}
