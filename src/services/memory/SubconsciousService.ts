import { getRelativeTimeDescription } from "../../utils/time-format.js";
import { GraphService, type MemoryResult } from "./GraphService.js";

export interface LLMClient {
  complete(prompt: string): Promise<{ text: string | null }>;
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
    // We look for patterns that repeat immediately.
    // Example: "PatternPattern" -> "Pattern"
    for (let len = Math.floor(text.length / 2); len >= 3; len--) {
      for (let i = 0; i <= text.length - 2 * len; i++) {
        const chunk = text.substring(i, i + len);
        const next = text.substring(i + len, i + 2 * len);
        if (chunk === next && chunk.trim().length >= 3) {
          // Truncation log reduced to avoid noise
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
  ): Promise<string[]> {
    if (!agent) {
      this.log(`  👁️ [OBSERVER] No agent available, using naive keyword extraction.`);
      // Fallback: simple keyword extraction if no agent
      return [
        currentPrompt
          .split(/\s+/)
          .filter((w) => w.length > 5)
          .slice(0, 3)
          .join(" "),
      ];
    }

    // 1. History Windowing: Only look at the last 5 messages to avoid bias towards old topics.
    const analysisWindow = recentMessages.slice(-5);
    const historyText =
      analysisWindow.length > 0
        ? analysisWindow
            .map((m) => {
              let mText = m.text || m.content || "";
              if (Array.isArray(mText)) {
                mText = mText.map((p) => (typeof p === "string" ? p : p.text || "")).join(" ");
              }
              return `${m.role}: ${String(mText)}`;
            })
            .join("\n")
        : "(No previous context)";

    const prompt = `You are the "Subconscious Observer". 
Analyze the current user input and generate 2-3 specific search keywords to find related memories.
Prioritize the CURRENT USER INPUT. Use the HISTORY only for disambiguation or context.

IMPORTANT: IGNORE all messaging protocol metadata (e.g., "[Telegram ...]", "tg:", "[WhatsApp ...]", "[Slack ...]", user IDs, timestamps) and focus ONLY on the natural language content of the message.

CURRENT USER INPUT:
"${currentPrompt}"

HISTORY (for context):
${historyText}

Respond with ONLY a newline-separated list of 1-3 terms (max 3 words each). 
BE CONCISE. DO NOT include headers or explanations.`;

    this.log(`  👁️ [OBSERVER] Analyzing context for search seeds...`);
    this.log(`      - Prompt: "${currentPrompt}"`);
    this.log(`      - Context: ${analysisWindow.length} prev messages`);
    if (analysisWindow.length > 0) {
      const lastMsg = analysisWindow[analysisWindow.length - 1];
      let lastText = lastMsg.text || lastMsg.content || "";
      if (Array.isArray(lastText)) {
        lastText = lastText.map((p) => (typeof p === "string" ? p : p.text || "")).join(" ");
      }
      this.log(`      - Last Context Msg: "${lastText}"`);
    }

    try {
      const response = await agent.complete(prompt);
      let rawOutput = (response?.text || "").trim();

      // Kill massive hallucinations / loops
      rawOutput = this.truncateRepetitive(rawOutput);

      this.log(`  🔍 [SEEKER] Raw LLM output: "${rawOutput.replace(/\n/g, "\\n")}"`);

      // 1. Loop Breaker: If LLM is repeating whole sentences/blocks,
      // we only care about the very beginning.
      const lines = rawOutput
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const queries: string[] = [];
      const seenWords = new Set<string>();

      for (const line of lines) {
        if (queries.length >= 3) {
          break;
        }

        let clean = line
          .replace(/^[-*•\d.]+\s*/, "")
          .replace(/["']/g, "")
          .trim();
        if (clean.length < 3) {
          continue;
        }

        // Dedup individual words across ALL queries to kill loops
        const tokens = clean.split(/\s+/);
        const uniqueTokens = tokens.filter((t) => {
          const lct = t.toLowerCase();
          if (seenWords.has(lct)) {
            return false;
          }
          seenWords.add(lct);
          return true;
        });

        if (uniqueTokens.length > 0) {
          const finalQ = uniqueTokens.join(" ");
          // Sanity check: no word should be abnormally long (prevents "stuck" words)
          const hasGarbage = uniqueTokens.some((t) => t.length > 25);
          if (finalQ.length > 2 && finalQ.length < 40 && !hasGarbage) {
            queries.push(finalQ);
          }
        }
      }

      const finalQueries = queries.slice(0, 3);

      if (finalQueries.length === 0) {
        // Fallback to naive: just first few words of prompt
        return [currentPrompt.split(/\s+/).slice(0, 4).join(" ")];
      }

      this.log(`  🔍 [SEEKER] Parsed queries: ${finalQueries.map((q) => `"${q}"`).join(", ")}`);
      return finalQueries;
    } catch {
      process.stderr.write(`  ⚠️ [SEEKER] Error generating queries, fallback to prompt start.\n`);
      return [currentPrompt.substring(0, 20)];
    }
  }

  /**
   * Identifies concrete entities from the current prompt to use as BFS seeds.
   */
  async extractEntities(currentPrompt: string, agent: LLMClient): Promise<string[]> {
    const prompt = `Identify 1-3 concrete entities (people, names, specific objects) in the text below.
Respond ONLY with the entities separated by commas.
If no specific entities are found, respond strictly with "NONE".

IMPORTANT: IGNORE all messaging protocol metadata (e.g., "[Telegram ...]", "tg:", "[WhatsApp ...]", "[Slack ...]", user IDs, timestamps). Do NOT extract the sender's name or ID unless it is explicitly part of the narrative content. Focus on the message CONTENT.

Text: "${currentPrompt}"`;

    const response = await agent.complete(prompt);
    let text = (response?.text || "").trim();

    // Kill massive hallucinations / loops
    text = this.truncateRepetitive(text);

    if (text.length > 0) {
      this.log(`  🔍 [ENTITY] Raw LLM output: "${text.replace(/\n/g, "\\n")}"`);
      this.log(`      - Source Text: "${currentPrompt}"`);
    }

    if (text.includes("NONE") || text.length < 2) {
      return [];
    }

    const rawItems = text
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    const entities: string[] = [];
    const seenWords = new Set<string>();

    for (const item of rawItems) {
      if (entities.length >= 3) {
        break;
      }

      const words = item.split(/\s+/);
      const uniqueWords = words.filter((w) => {
        const lw = w.toLowerCase();
        if (seenWords.has(lw) || lw.length > 25) {
          return false;
        }
        seenWords.add(lw);
        return true;
      });

      if (uniqueWords.length > 0) {
        entities.push(uniqueWords.join(" "));
      }
    }

    return entities;
  }

  /**
   * The Echo Filter:
   * Prevents repeating the same memories too frequently.
   */
  private applyEchoFilter(results: MemoryResult[]): MemoryResult[] {
    const beforeCount = results.length;
    const filtered = results.filter((r) => {
      // RESONANCE BOOST: If it's the #1 hit for a specific query search (marked externally),
      // we might want to bypass the filter. For now, let's stick to strict filter
      // but only if it's NOT a very strong match or some other criteria.
      // Actually, let's just make the window smaller as done before,
      // and allow "Boosted" items if we add that flag.
      if (r._boosted) {
        return true;
      }

      const id = r.message?.uuid || r.uuid || JSON.stringify(r.text || r.content);
      if (this.recentlyRecalled.has(id)) {
        return false;
      }
      return true;
    });

    const filteredCount = beforeCount - filtered.length;
    if (filteredCount > 0) {
      this.log(`  ♻️[ECHO FILTER] Blocked ${filteredCount} redundant memories.`);
    }

    // Extended Debug for lost facts
    filtered.forEach((r) => {
      if (r._sourceQuery && r._sourceQuery.includes("Fact")) {
        this.log(`  ✅[ECHO PASS] Fact retained: "${r.content}"`);
      }
    });

    // Track only the ones we actually USE (the filtered ones)
    // Wait, if we track everything, we prevent them from coming back.
    // Let's only track the ones that passed the filter.
    filtered.forEach((r) => {
      const id = r.message?.uuid || r.uuid || JSON.stringify(r.text || r.content);
      this.recentlyRecalled.add(id);
    });

    // Limit cache size
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

    const beforeCount = results.length;
    const filtered = results.filter((r) => {
      let timestamp: string | Date | undefined =
        r.message?.created_at || r.message?.createdAt || r.timestamp;

      // Extract content to check for embedded tags
      const content = r.message?.content || r.text || r.content || "";
      const dateTagMatch = content.match(
        /(?:Ocurrido el|memory log for|FECHA:|DATE:)\s*(\d{4}-\d{2}-\d{2})/i,
      );
      let source = "metadata";

      if (dateTagMatch) {
        timestamp = dateTagMatch[1];
        source = "tag";
      } else {
        const tsMatch = content.match(/\[TIMESTAMP:([^\]]+)\]/);
        if (tsMatch) {
          timestamp = tsMatch[1];
          source = "embedded";
        }
      }

      const thresholdStr = oldestContextTimestamp.toISOString();
      if (!timestamp) {
        this.log(
          `  ✅[HORIZON] Allowed: No timestamp | Threshold(${thresholdStr}) | "${content.replace(/\n/g, " ")}"`,
        );
        return true;
      }

      const memoryDate = new Date(timestamp);

      if (isNaN(memoryDate.getTime())) {
        this.log(
          `  ⚠️[HORIZON] Skipped invalid date: "${timestamp}" | "${content.replace(/\n/g, " ")}"`,
        );
        return true; // Default to allow if date is broken
      }

      const isAllowed = memoryDate < oldestContextTimestamp;

      const status = isAllowed ? "✅" : "❌";
      const action = isAllowed ? "Allowed" : "Blocked";
      const memDateStr = memoryDate.toISOString();
      const isFact = r._sourceQuery?.includes("Fact"); /* Check if it came from facts */
      const typeLabel = isFact ? "[FACT]" : "[NODE]";

      this.log(
        `  ${status}[HORIZON] ${action}: ${typeLabel} Mem(${memDateStr} via ${source}) < Threshold(${thresholdStr}) | "${content.replace(/\n/g, " ")}"`,
      );

      return isAllowed;
    });

    const filteredCount = beforeCount - filtered.length;
    if (filteredCount > 0) {
      this.log(
        `  🌅[HORIZON] Total blocked: ${filteredCount} memories newer than conversation context.`,
      );
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
  ): Promise<string> {
    this.log("🧠 [MIND] Subconscious is exploring memories...");

    const queries = [
      ...new Set(
        await this.generateSeekerQueries(currentPrompt, recentMessages, agent ?? undefined),
      ),
    ];

    // 1. Neural Resonance (Graph Retrieval)
    const entities = agent ? await this.extractEntities(currentPrompt, agent) : [];
    let allResults: MemoryResult[] = [];

    if (entities.length > 0) {
      this.log(`  🔗[GRAPH] Seeds found: ${entities.join(", ")}.Exploring graph...`);
      const graphMemories = await this.graph.searchGraph(sessionId, entities, 2);
      if (graphMemories.length > 0) {
        this.log(`    ✅[GRAPH] Found ${graphMemories.length} memories via graph traversal.`);
        allResults = [...graphMemories];
      } else {
        this.log(`    ❌[GRAPH] No memories found via graph traversal.`);
      }
    }

    // 2. Supplemental Semantic Search for Seeker Queries
    for (const query of queries) {
      this.log(`  🔎[GRAPH] Deep searching for: "${query}"...`);

      // Parallel search for nodes and facts
      const [nodes, facts] = await Promise.all([
        this.graph.searchNodes(sessionId, query),
        this.graph.searchFacts(sessionId, query),
      ]);

      if (nodes.length > 0) {
        this.log(`    ✅[GRAPH] Found ${nodes.length} nodes for query: "${query}"`);
        allResults.push(...nodes);
      }
      if (facts.length > 0) {
        this.log(`    ✅[GRAPH] Found ${facts.length} facts for query: "${query}"`);
        facts.forEach((f) => {
          this.log(`       -> Fact: "${f.content}"`);
        });
        allResults.push(...facts);
      }

      if (nodes.length === 0 && facts.length === 0) {
        this.log(`    ❌[GRAPH] No results for query: "${query}"`);
      }
    }

    if (allResults.length === 0) {
      this.log("💤 [MIND] No relevant memories found.");
      return "";
    }

    // Deduplicate by content or a unique ID if available
    const uniqueMap = new Map<string, MemoryResult>();
    for (const r of allResults) {
      const id = r.content; // Assuming 'content' can serve as a unique identifier
      if (!uniqueMap.has(id)) {
        uniqueMap.set(id, r);
      }
    }
    allResults = Array.from(uniqueMap.values());

    this.log(`  📊[SYNTHESIZER] Total unique matches: ${allResults.length} `);

    // 3. Memory Horizon (Temporal Filter)
    // Ensures we don't inject things that are already in the visible context
    const horizonFiltered = this.applyMemoryHorizon(allResults, oldestContextTimestamp);

    // 4. Echo Filter (Satiety)
    const deduplicated = this.applyEchoFilter(horizonFiltered);

    // Deduplicate exact content early to allow variety, then sort to prioritize:
    // 1) BOOSTED, 2) Facts over Nodes, 3) Interleaving old and new to avoid "all from same day"
    deduplicated.sort((a, b) => {
      // First tier: Boosted
      if (a._boosted && !b._boosted) return -1;
      if (!a._boosted && b._boosted) return 1;

      // Second tier: Facts over Nodes
      const aIsFact = a._sourceQuery?.includes("Fact") ?? false;
      const bIsFact = b._sourceQuery?.includes("Fact") ?? false;
      if (aIsFact && !bIsFact) return -1;
      if (!aIsFact && bIsFact) return 1;

      // Third tier: Pseudo-random distribution based on timestamp parity to mix old/new
      const aTs = a.timestamp || a.message?.created_at || a.message?.createdAt || 0;
      const bTs = b.timestamp || b.message?.created_at || b.message?.createdAt || 0;
      const timeDiff = new Date(aTs).getTime() - new Date(bTs).getTime();
      return Math.random() > 0.5 ? timeDiff : -timeDiff;
    });

    const finalLines: string[] = [];
    const seenContent = new Set<string>();

    for (const r of deduplicated) {
      if (finalLines.length >= 5) {
        break;
      }
      let content = r.message?.content || r.text || r.content || "";
      // Strip timestamp tags
      content = content.replace(/\[TIMESTAMP:[^\]]+\]/g, "").trim();

      // Filter out technical JSON strings that might leak
      if (content.startsWith("{") && content.endsWith("}")) {
        continue;
      }

      // TOUGH DEDUPLICATION: Strip fillers and normalize
      const fillerRegex = /^(oye|recuerda|sabias que|dime|hey|escucha)[,\s]*/gi;
      const normalizedForComparison = content
        .replace(fillerRegex, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .substring(0, 30);

      if (!normalizedForComparison || seenContent.has(normalizedForComparison)) {
        if (r._sourceQuery?.includes("Fact")) {
          this.log(`  🗑️[DEDUP] Dropping Fact(already seen): "${content}"`);
        }
        continue;
      }

      seenContent.add(normalizedForComparison);

      let finalDate: Date = r.message?.created_at ? new Date(r.message?.created_at) : new Date();
      if (r.message?.createdAt) {
        finalDate = new Date(r.message.createdAt);
      }
      if (r.timestamp) {
        finalDate = new Date(r.timestamp);
      }

      // Check for common date tags (DATE, etc)
      const dateTagMatch = content.match(
        /(?:memory log for|DATE:)\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?)/i,
      );
      if (dateTagMatch) {
        const taggedDate = new Date(dateTagMatch[1]);
        if (!isNaN(taggedDate.getTime())) {
          finalDate = taggedDate;
        }
      }

      // Check for embedded [TIMESTAMP:...]
      const timestampMatch = content.match(/\[TIMESTAMP:([^\]]+)\]/);
      if (timestampMatch) {
        const embeddedDate = new Date(timestampMatch[1]);
        if (!isNaN(embeddedDate.getTime())) {
          finalDate = embeddedDate;
          content = content.replace(timestampMatch[0], "").trim();
        }
      }

      const relativeTime = getRelativeTimeDescription(finalDate);
      const isFact = r._sourceQuery?.includes("Fact") ?? false;

      if (isFact) {
        this.log(`  ✨[FINAL] Adding Fact to Resonance: "${content}"`);
      }

      finalLines.push(`- [${relativeTime}] ${content} `);
    }

    if (finalLines.length === 0) {
      this.log("💤 [MIND] No relevant memories passed filters.");
      return "";
    }

    let rewrittenLines = finalLines.join("\n");
    if (agent) {
      this.log("  ✍️ [MIND] Rewriting memories into natural first-person narrative...");
      const translationPrompt = `Convert the following database notes into personal, first-person memories. 
You are the AI remembering your past interactions with the user.
CRITICAL: Write the memories in the EXACT SAME LANGUAGE as the CURRENT USER MESSAGE below.
Keep it fluid, natural, and conversational.
Do not use log formats ("human", "assistant"), remove all that.
Maintain a bulleted list format, one memory per line.
The raw memories include fuzzy relative timestamps like [hace 2 semanas] or [yesterday morning]. Incorporate them naturally into each sentence rather than keeping them as bracketed labels.

STRICT RULES — NEVER break these:
1. Do NOT invent or infer ANY fact, action, method, or context that is not EXPLICITLY stated in the RAW MEMORIES below.
2. Do NOT add sensory details like "I heard", "I saw", "I felt" unless that is literally written in the source.
3. If the source says "the user spoke on the phone", write "the user spoke on the phone" — do NOT say "I heard you speak on the phone" as that implies the AI was present.
4. Only rephrase style and point-of-view (1st person). Keep ALL facts strictly sourced from the raw text.
5. When uncertain, stay closer to the original wording rather than embellishing.
${soulContext ? `\n=== YOUR UNIQUE PERSONA (SOUL) ===\n${soulContext}\n=========================\nYou MUST write these memories adopting this personality, tone, and worldview.\n` : ""}${storyContext ? `\n=== YOUR ONGOING NARRATIVE (STORY) ===\n${storyContext}\n=========================\nUse this as background context to better understand the relationship and history with the user.\n` : ""}
CURRENT USER MESSAGE (Detect language from this):
"${currentPrompt}"

RAW MEMORIES:
${finalLines.join("\n")}`;

      const res = await agent.complete(translationPrompt);
      if (res.text && res.text.trim().length > 0) {
        // Remove hallucinatory intros like "Aquí están tus recuerdos:"
        rewrittenLines = res.text
          .split("\n")
          .filter(l => l.trim().startsWith("-") || l.trim().startsWith("•"))
          .join("\n");
          
        if (rewrittenLines.length === 0) {
           // fallback if it didn't use bullet points
           rewrittenLines = res.text.trim();
        }
        this.log(`  ✅ [MIND] Rewritten successfully.`);
      }
    }

    const finalFlashback = `
---
[SUBCONSCIOUS RESONANCE]
${rewrittenLines}
---
`;

    // Only log the final resonance block if debug is on
    if (this.debug) {
      this.log(`\n ================================================ `);
      this.log(`🧠[MIND] DRIFTING INTO RESONANCE: \n${finalFlashback} `);
      this.log(`================================================\n`);
    }

    return finalFlashback;
  }
}
