import type { EpisodeEncoder } from "./encoder.js";
import type { EpisodicStore } from "./store.js";
import type { EpisodeSearchOptions, EpisodeSearchResult } from "./types.js";

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Guard against embeddings from different models / dimension counts.
  // Mismatched vectors produce NaN scores that break ranking; return 0
  // (no similarity) so the episode falls back to keyword matching instead.
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function temporalRecency(
  createdAt: string,
  importance: number,
  useImportanceModulation: boolean,
): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const halfLifeDays = 30; // base half-life

  let effectiveHalfLife = halfLifeDays;
  if (useImportanceModulation) {
    // importance=1.0 → 4x longer half-life
    effectiveHalfLife = halfLifeDays * (1 + importance * 3);
  }

  return Math.exp((-ageDays * Math.LN2) / effectiveHalfLife);
}

export class EpisodicSearch {
  constructor(
    private store: EpisodicStore,
    private encoder: EpisodeEncoder,
  ) {}

  async search(options: EpisodeSearchOptions): Promise<EpisodeSearchResult[]> {
    const {
      query,
      timeRange,
      minImportance = 0.0,
      emotionalFilter,
      topicTags,
      temporalWeighting = { enabled: true, importanceModulatedDecay: true },
      limit = 10,
    } = options;

    // Get all episodes first — if the store is empty we can return early
    // without paying for an embedding API round-trip.
    let episodes = this.store.getAll();
    if (episodes.length === 0) {
      return [];
    }

    // Get query embedding
    let queryEmbedding = options.queryEmbedding;
    if (!queryEmbedding) {
      queryEmbedding = await this.encoder.generateEmbedding(query);
    }

    // Apply filters
    if (timeRange?.after) {
      const after = timeRange.after;
      episodes = episodes.filter((e) => e.created_at >= after);
    }
    if (timeRange?.before) {
      const before = timeRange.before;
      episodes = episodes.filter((e) => e.created_at <= before);
    }
    if (minImportance > 0) {
      episodes = episodes.filter((e) => e.importance >= minImportance);
    }
    if (emotionalFilter?.valence === "positive") {
      episodes = episodes.filter((e) => e.emotional_valence > 0);
    } else if (emotionalFilter?.valence === "negative") {
      episodes = episodes.filter((e) => e.emotional_valence < 0);
    }
    if (emotionalFilter?.minArousal != null) {
      const minArousal = emotionalFilter.minArousal;
      episodes = episodes.filter((e) => e.emotional_arousal >= minArousal);
    }
    if (topicTags && topicTags.length > 0) {
      episodes = episodes.filter((e) => {
        const tags = e.topic_tags ?? [];
        return topicTags.some((t) => tags.includes(t));
      });
    }

    // Score episodes
    const results: EpisodeSearchResult[] = [];

    for (const episode of episodes) {
      // Semantic similarity
      let semanticScore = 0;
      if (episode.embedding && episode.embedding.length > 0) {
        semanticScore = Math.max(0, cosineSimilarity(queryEmbedding, episode.embedding));
      } else {
        // Fallback: keyword matching
        const queryWords = query.toLowerCase().split(/\s+/);
        const text = (episode.summary + " " + (episode.details ?? "")).toLowerCase();
        const matches = queryWords.filter((w) => text.includes(w)).length;
        semanticScore = (matches / Math.max(queryWords.length, 1)) * 0.5;
      }

      // Temporal recency
      const temporalScore = temporalWeighting.enabled
        ? temporalRecency(
            episode.created_at,
            episode.importance,
            temporalWeighting.importanceModulatedDecay,
          )
        : 0.5;

      // Importance
      const importanceScore = episode.importance;

      // Access frequency (normalized, max cap at 100 accesses)
      const accessScore = Math.min(episode.access_count / 100, 1.0);

      // Emotional intensity
      const emotionalScore = Math.abs(episode.emotional_valence) * episode.emotional_arousal;

      // Combined score
      const score =
        semanticScore * 0.4 +
        temporalScore * 0.2 +
        importanceScore * 0.2 +
        accessScore * 0.1 +
        emotionalScore * 0.1;

      results.push({
        episode,
        score,
        scoreBreakdown: {
          semantic: semanticScore,
          temporal: temporalScore,
          importance: importanceScore,
          accessFrequency: accessScore,
          emotionalIntensity: emotionalScore,
        },
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    // Update access counts and associations
    const topIds = topResults.map((r) => r.episode.id);
    for (const result of topResults) {
      this.store.recordAccess(result.episode.id);
      result.episode.access_count += 1; // reflect in result
    }

    // Strengthen associations between co-retrieved episodes
    for (let i = 0; i < topIds.length; i++) {
      for (let j = i + 1; j < topIds.length; j++) {
        this.store.upsertAssociation(topIds[i], topIds[j]);
        this.store.upsertAssociation(topIds[j], topIds[i]);
      }
    }

    return topResults;
  }
}
