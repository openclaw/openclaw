/**
 * Build a system prompt section from policy hints.
 *
 * When the policy feedback subsystem is in advisory or active mode, this
 * returns a text block that can be injected into the agent's system prompt
 * to inform the LLM about current policy signals (fatigue, timing, etc.).
 *
 * Returns undefined when the subsystem is off or passive (no prompt injection).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PolicyHints } from "./types.js";

const log = createSubsystemLogger("policy-feedback:prompt-hints");

/**
 * Format policy hints into a system prompt section.
 * Returns undefined if hints indicate no advisory content is needed.
 */
export function formatPolicyHintsForPrompt(hints: PolicyHints): string | undefined {
  // Only inject in advisory or active modes
  if (hints.mode === "off" || hints.mode === "passive") {
    return undefined;
  }

  const lines: string[] = [];

  // Recommendation
  if (hints.recommendation === "suppress") {
    lines.push(
      "The policy feedback system recommends SUPPRESSING this response.",
      "Consider responding with silence unless the user's message clearly demands a reply.",
    );
  } else if (hints.recommendation === "caution") {
    lines.push(
      "The policy feedback system recommends CAUTION with this response.",
      "Keep your reply brief and high-value. Avoid unnecessary follow-ups.",
    );
  }

  // Fatigue
  if (hints.fatigueLevel > 0.5) {
    lines.push(
      `Intervention fatigue is elevated (${(hints.fatigueLevel * 100).toFixed(0)}%). Prefer shorter, less intrusive responses.`,
    );
  }

  // Tone hints
  if (hints.toneHints && hints.toneHints.length > 0) {
    for (const hint of hints.toneHints) {
      lines.push(hint);
    }
  }

  // Timing
  if (hints.timingHint) {
    lines.push(hints.timingHint);
  }

  // Reasons (condensed)
  if (hints.reasons.length > 0) {
    lines.push(`Signals: ${hints.reasons.join("; ")}`);
  }

  if (lines.length === 0) {
    return undefined;
  }

  log.debug("policy hints injected into prompt", {
    recommendation: hints.recommendation,
    lineCount: lines.length,
  });

  return lines.join("\n");
}
