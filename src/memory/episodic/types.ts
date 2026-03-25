export interface Episode {
  id: string;
  agent_id: string;
  session_key?: string;
  created_at: string; // ISO-8601

  // Content
  summary: string;
  details?: string;
  participants?: string[]; // stored as JSON

  // Emotional weighting
  importance: number; // 0.0-1.0
  emotional_valence: number; // -1.0 to 1.0
  emotional_arousal: number; // 0.0-1.0

  // Context binding
  topic_tags?: string[]; // stored as JSON
  linked_episodes?: string[]; // stored as JSON
  context_hash?: string;

  // Consolidation state
  consolidation_status: "raw" | "reviewed" | "consolidated" | "archived";
  consolidation_count: number;
  last_accessed_at?: string;
  access_count: number;

  // Vector
  embedding?: Float32Array;
}

export interface EpisodeAssociation {
  episode_id: string;
  associated_id: string;
  strength: number;
  created_at: string;
}

export interface EpisodeSearchOptions {
  query: string;
  queryEmbedding?: Float32Array;
  timeRange?: {
    after?: string;
    before?: string;
  };
  minImportance?: number;
  emotionalFilter?: {
    valence?: "positive" | "negative" | "any";
    minArousal?: number;
  };
  topicTags?: string[];
  temporalWeighting?: {
    enabled: boolean;
    importanceModulatedDecay: boolean;
  };
  expandAssociations?: boolean;
  limit?: number;
}

export interface EpisodeSearchResult {
  episode: Episode;
  score: number;
  scoreBreakdown: {
    semantic: number;
    temporal: number;
    importance: number;
    accessFrequency: number;
    emotionalIntensity: number;
  };
}

export interface EncodedEpisode {
  summary: string;
  details?: string;
  importance: number;
  emotional_valence: number;
  emotional_arousal: number;
  topic_tags: string[];
  participants?: string[];
}

export interface ConsolidationPattern {
  type: "frequency" | "decision" | "knowledge" | "preference" | "correction";
  description: string;
  episodes: Episode[];
  suggestedMemoryUpdate: string;
  confidence: number;
}

export interface ConsolidationReport {
  timestamp: string;
  episodesScanned: number;
  patternsFound: ConsolidationPattern[];
  suggestedMemoryUpdates: string[];
  episodesConsolidated: string[];
  summary: string;
}
