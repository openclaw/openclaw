/**
 * Core types for the experiential capture system.
 *
 * These types model the data that flows through the capture, evaluation,
 * and reconstitution pipeline.
 */

/** Where a captured moment originated */
export type MomentSource = "tool_use" | "compaction" | "session_boundary" | "message";

/** Multi-dimensional significance scoring (all values 0-1) */
export type SignificanceScore = {
  total: number;
  emotional: number;
  uncertainty: number;
  relationship: number;
  consequential: number;
  reconstitution: number;
};

/** How the system decides to handle a captured moment */
export type CaptureDisposition = "immediate" | "buffered" | "archived" | "skipped";

/** A single captured experiential moment */
export type ExperientialMoment = {
  id: string;
  version: number;
  timestamp: number;
  sessionKey: string;
  source: MomentSource;
  content: string;
  toolName?: string;
  significance: SignificanceScore;
  disposition: CaptureDisposition;
  reasons: string[];
  emotionalSignature?: string;
  anchors: string[];
  uncertainties: string[];
};

/** Summary of experiential data from a completed session */
export type SessionSummary = {
  id: string;
  version: number;
  sessionKey: string;
  startedAt: number;
  endedAt: number;
  topics: string[];
  emotionalArc?: string;
  momentCount: number;
  keyAnchors: string[];
  openUncertainties: string[];
  reconstitutionHints: string[];
};

/** Snapshot of experiential state before context compaction */
export type CompactionCheckpoint = {
  id: string;
  version: number;
  timestamp: number;
  sessionKey: string;
  trigger: string;
  activeTopics: string[];
  keyContextSummary: string;
  openUncertainties: string[];
  conversationAnchors: string[];
};
