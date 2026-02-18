export type EpisodeEvent = {
  id: string;
  session_key: string;
  timestamp: number;
  user_intent: string;
  action_taken: string;
  outcome: string;
  raw_json: string;
  embedding: string | null; // JSON float array
  importance: number;
};

export type SemanticNode = {
  id: string;
  type: string; // "preference" | "skill" | "project" | "person" | "rule"
  label: string;
  value: string;
  evidence_count: number;
  created_at: number;
  updated_at: number;
};

export type SemanticEdge = {
  from_node: string;
  to_node: string;
  relation: string; // "related_to" | "implies" | "contradicts"
  weight: number;
};

export type BioMemContext = {
  episodes: EpisodeEvent[];
  semanticNodes: SemanticNode[];
};
