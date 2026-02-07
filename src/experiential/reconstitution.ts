/**
 * Reconstitution context builder.
 *
 * Generates depth-appropriate experiential context for injection
 * at session start. The depth is determined by time since last activity.
 */

import type { CompactionCheckpoint, ExperientialMoment, SessionSummary } from "./types.js";

export type ReconstitutionDepth = "quick" | "standard" | "deep";

/** Determine reconstitution depth based on hours since last activity */
export function determineDepth(lastActivityTimestamp: number | null): ReconstitutionDepth {
  if (!lastActivityTimestamp) {
    return "deep";
  }

  const hoursElapsed = (Date.now() - lastActivityTimestamp) / (1000 * 60 * 60);
  if (hoursElapsed < 4) {
    return "quick";
  }
  if (hoursElapsed <= 24) {
    return "standard";
  }
  return "deep";
}

export type ReconstitutionParams = {
  depth: ReconstitutionDepth;
  summaries: SessionSummary[];
  checkpoints: CompactionCheckpoint[];
  moments: ExperientialMoment[];
};

/** Build markdown reconstitution context based on depth and available data */
export function buildReconstitutionContext(params: ReconstitutionParams): string {
  const { depth, summaries, checkpoints, moments } = params;
  const sections: string[] = ["# Experiential Continuity", ""];

  if (summaries.length === 0 && checkpoints.length === 0 && moments.length === 0) {
    sections.push("*No prior experiential data available.*");
    return sections.join("\n");
  }

  // Recent session context
  if (summaries.length > 0) {
    sections.push("## Recent Sessions", "");
    const limit = depth === "quick" ? 1 : depth === "standard" ? 2 : 3;
    for (const summary of summaries.slice(0, limit)) {
      if (summary.topics.length > 0) {
        sections.push(`- **Topics**: ${summary.topics.join(", ")}`);
      }
      if (summary.emotionalArc) {
        sections.push(`- **Emotional arc**: ${summary.emotionalArc}`);
      }
      if (summary.keyAnchors.length > 0) {
        sections.push(`- **Key anchors**: ${summary.keyAnchors.join("; ")}`);
      }
      if (summary.openUncertainties.length > 0) {
        sections.push(`- **Open questions**: ${summary.openUncertainties.join("; ")}`);
      }
      for (const hint of summary.reconstitutionHints) {
        sections.push(`- ${hint}`);
      }
      sections.push("");
    }
  }

  // Compaction checkpoints (standard and deep only)
  if (depth !== "quick" && checkpoints.length > 0) {
    sections.push("## Context Checkpoints", "");
    for (const cp of checkpoints.slice(0, 2)) {
      if (cp.activeTopics.length > 0) {
        sections.push(`- **Active topics**: ${cp.activeTopics.join(", ")}`);
      }
      if (cp.conversationAnchors.length > 0) {
        sections.push(`- **Anchors**: ${cp.conversationAnchors.join("; ")}`);
      }
    }
    sections.push("");
  }

  // Significant moments (deep only)
  if (depth === "deep" && moments.length > 0) {
    sections.push("## Significant Moments", "");
    for (const moment of moments.slice(0, 5)) {
      const sig = moment.emotionalSignature ? ` (${moment.emotionalSignature})` : "";
      sections.push(`- ${moment.content.slice(0, 200)}${sig}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}
