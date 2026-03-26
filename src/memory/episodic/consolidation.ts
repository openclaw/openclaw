import OpenAI from "openai";
import type { EpisodicStore } from "./store.js";
import type { Episode, ConsolidationPattern, ConsolidationReport } from "./types.js";

function getTagOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const intersection = b.filter((t) => setA.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function clusterEpisodes(episodes: Episode[], threshold = 0.3): Episode[][] {
  const clusters: Episode[][] = [];
  const assigned = new Set<string>();

  for (const episode of episodes) {
    if (assigned.has(episode.id)) {
      continue;
    }

    const cluster: Episode[] = [episode];
    assigned.add(episode.id);

    const tags = episode.topic_tags ?? [];

    for (const other of episodes) {
      if (assigned.has(other.id)) {
        continue;
      }
      const otherTags = other.topic_tags ?? [];
      if (tags.length === 0 && otherTags.length === 0) {
        continue;
      }

      const overlap = getTagOverlap(tags, otherTags);
      if (overlap >= threshold) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation engine. Analyze the following episodes (memories from past conversations) and identify patterns.

For each cluster of related episodes, determine:
1. What type of pattern this is: frequency (repeated topics), decision (explicit decisions made), knowledge (accumulated knowledge), preference (user preferences), correction (corrections to earlier beliefs)
2. What the pattern is
3. What should be written to long-term memory (MEMORY.md)

Respond with JSON:
{
  "patterns": [
    {
      "type": "frequency|decision|knowledge|preference|correction",
      "description": "Description of the pattern found",
      "suggestedMemoryUpdate": "Exact text to add/update in MEMORY.md",
      "confidence": 0.0-1.0
    }
  ],
  "overallSummary": "Brief summary of this consolidation cycle"
}

Only respond with valid JSON, no markdown.`;

interface LLMPattern {
  type: ConsolidationPattern["type"];
  description: string;
  suggestedMemoryUpdate: string;
  confidence: number;
}

interface LLMConsolidationResponse {
  patterns?: LLMPattern[];
  overallSummary?: string;
}

export class ConsolidationEngine {
  private client: OpenAI;

  constructor(private store: EpisodicStore) {
    const apiKey = process.env["OPENAI_API_KEY"] ?? "local-key";
    const baseURL = process.env["OPENAI_BASE_URL"] ?? undefined;
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async run(agentId?: string): Promise<ConsolidationReport> {
    const startTime = Date.now();
    const episodes = this.store.getForConsolidation(agentId);

    if (episodes.length === 0) {
      return {
        timestamp: new Date().toISOString(),
        episodesScanned: 0,
        patternsFound: [],
        suggestedMemoryUpdates: [],
        episodesConsolidated: [],
        summary: "No episodes to consolidate.",
      };
    }

    // Phase 1: Cluster
    const clusters = clusterEpisodes(episodes);

    // Phase 2: Identify patterns via LLM
    const patterns: ConsolidationPattern[] = [];
    const consolidatedIds: string[] = [];

    for (const cluster of clusters) {
      if (cluster.length < 1) {
        continue;
      }

      const clusterText = cluster
        .map(
          (e, i) =>
            `Episode ${i + 1} (importance: ${e.importance.toFixed(2)}, created: ${e.created_at.split("T")[0]}):\n` +
            `Summary: ${e.summary}\n` +
            (e.details ? `Details: ${e.details}\n` : "") +
            `Tags: ${(e.topic_tags ?? []).join(", ")}`,
        )
        .join("\n\n---\n\n");

      try {
        const chatModel = process.env["OPENAI_CHAT_MODEL"] ?? "gpt-4o-mini";
        const response = await this.client.chat.completions.create({
          model: chatModel,
          messages: [
            { role: "system", content: CONSOLIDATION_PROMPT },
            { role: "user", content: `Analyze these related episodes:\n\n${clusterText}` },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          continue;
        }

        // Robustly extract JSON: strip markdown fences, sanitize common LLM issues
        let cleaned = content
          .replace(/^```(?:json)?\s*\n?/gm, "")
          .replace(/\n?```\s*$/gm, "")
          .trim();

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          continue;
        }

        let jsonStr = jsonMatch[0].replace(/,\s*([\]}])/g, "$1");

        const parsed = JSON.parse(jsonStr) as LLMConsolidationResponse;

        for (const p of parsed.patterns ?? []) {
          patterns.push({
            type: p.type,
            description: p.description,
            episodes: cluster,
            suggestedMemoryUpdate: p.suggestedMemoryUpdate,
            confidence: p.confidence,
          });
        }

        // Mark episodes as consolidated only on successful LLM processing
        for (const ep of cluster) {
          this.store.updateStatus(ep.id, "consolidated");
          consolidatedIds.push(ep.id);
        }
      } catch (err) {
        console.error("[Consolidation] Error processing cluster:", err);
        // Episodes remain in 'raw'/'reviewed' state and will be retried next cycle
      }
    }

    // Phase 3: Strengthen associations (episodes in same cluster get associated)
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          this.store.upsertAssociation(cluster[i].id, cluster[j].id, 0.5);
          this.store.upsertAssociation(cluster[j].id, cluster[i].id, 0.5);
        }
      }
    }

    const suggestedMemoryUpdates = patterns
      .filter((p) => p.confidence >= 0.6)
      .map((p) => `[${p.type.toUpperCase()}] ${p.suggestedMemoryUpdate}`);

    return {
      timestamp: new Date().toISOString(),
      episodesScanned: episodes.length,
      patternsFound: patterns,
      suggestedMemoryUpdates,
      episodesConsolidated: consolidatedIds,
      summary: `Scanned ${episodes.length} episodes, found ${patterns.length} patterns, consolidated ${consolidatedIds.length} episodes in ${Date.now() - startTime}ms.`,
    };
  }
}
