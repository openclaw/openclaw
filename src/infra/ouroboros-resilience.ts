/**
 * Ouroboros Resilience — Phase 3
 *
 * 4 stagnation patterns + 5 thinking personas for breaking through agent stuck states.
 * Coexists with existing task-self-driving.ts stagnation detection (stalled_step, zero_progress).
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("ouroboros-resilience");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StagnationPattern = "spinning" | "oscillation" | "no_drift" | "diminishing_returns";

export type ThinkingPersona = "hacker" | "researcher" | "simplifier" | "architect" | "contrarian";

export interface StagnationDetection {
  pattern: StagnationPattern;
  confidence: number; // 0.0–1.0
  details: string;
}

export interface OuroborosHistory {
  outputHashes: string[];
  driftScores: number[];
  appliedPersonas: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Minimum history length before attempting detection
const MIN_HISTORY_FOR_DETECTION = 3;

// Spinning: same output hash repeated N times
const SPINNING_THRESHOLD = 3;

// Oscillation: A-B-A-B pattern detection window
const OSCILLATION_WINDOW = 4;

// No drift: average drift score below threshold
const NO_DRIFT_THRESHOLD = 0.05;
const NO_DRIFT_WINDOW = 4;

// Diminishing returns: drift scores trending down
const DIMINISHING_RETURNS_WINDOW = 4;
const DIMINISHING_RETURNS_RATIO = 0.3; // final drift < 30% of initial

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------

/** Pattern → preferred personas (ordered by affinity) */
export const PERSONA_AFFINITY: Record<StagnationPattern, ThinkingPersona[]> = {
  spinning: ["hacker", "contrarian", "simplifier"],
  oscillation: ["architect", "researcher", "simplifier"],
  no_drift: ["contrarian", "hacker", "researcher"],
  diminishing_returns: ["simplifier", "architect", "contrarian"],
};

export const PERSONA_PROMPTS: Record<ThinkingPersona, string> = {
  hacker: `[OUROBOROS PERSONA: HACKER]
You are now thinking like a hacker. Forget conventional approaches.
- Look for shortcuts, workarounds, and unconventional solutions
- Break the problem apart — what's the minimal change that unblocks progress?
- Consider monkey-patching, temporary hacks, or creative bypasses
- If the "right" way isn't working, find ANY way that works first
- Question whether the current approach is fundamentally wrong`,

  researcher: `[OUROBOROS PERSONA: RESEARCHER]
You are now thinking like a researcher. Step back and analyze systematically.
- Re-read error messages and logs carefully — what are they ACTUALLY saying?
- Search for similar issues in docs, READMEs, or code comments
- Form hypotheses about root cause and test them one at a time
- Look at the problem from the perspective of the system architecture
- Consider version mismatches, configuration issues, or environmental factors`,

  simplifier: `[OUROBOROS PERSONA: SIMPLIFIER]
You are now thinking like a simplifier. The current approach is too complex.
- Can you solve this with fewer steps? Fewer files? Fewer dependencies?
- Strip away everything non-essential and focus on the core problem
- Would a simpler data structure, algorithm, or architecture work?
- Consider deleting code rather than adding more
- Ask: "What is the simplest thing that could possibly work?"`,

  architect: `[OUROBOROS PERSONA: ARCHITECT]
You are now thinking like an architect. Zoom out and reconsider the design.
- Is the current task decomposition correct? Should steps be reordered?
- Are you solving the right problem? Re-read the original requirements
- Consider alternative architectural approaches entirely
- Look at the interfaces between components — is the boundary wrong?
- Would changing the abstraction level unblock progress?`,

  contrarian: `[OUROBOROS PERSONA: CONTRARIAN]
You are now thinking like a contrarian. Challenge every assumption.
- What if the opposite of your current approach is correct?
- List your top 3 assumptions and question each one
- What would someone who disagrees with your approach suggest?
- Is there a requirement you've been treating as fixed that could flex?
- What if the "error" is actually correct behavior and your expectation is wrong?`,
};

// All personas in a fixed order for exhaustive iteration
const ALL_PERSONAS: ThinkingPersona[] = [
  "hacker",
  "researcher",
  "simplifier",
  "architect",
  "contrarian",
];

// ---------------------------------------------------------------------------
// Hash utility
// ---------------------------------------------------------------------------

/** Compute a short SHA-256 hash of a string (first 16 hex chars). */
export function hashOutput(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compute a drift score between two output hashes (0.0 = identical, 1.0 = completely different).
 * Uses character-level difference of the hex hashes as a simple proxy.
 */
export function computeDrift(hashA: string, hashB: string): number {
  if (hashA === hashB) {
    return 0;
  }
  const len = Math.max(hashA.length, hashB.length);
  if (len === 0) {
    return 0;
  }
  let diffs = 0;
  for (let i = 0; i < len; i++) {
    if (hashA[i] !== hashB[i]) {
      diffs++;
    }
  }
  return diffs / len;
}

// ---------------------------------------------------------------------------
// Stagnation detection
// ---------------------------------------------------------------------------

/**
 * Detect stagnation patterns from execution history.
 * Returns the most confident detection, or null if no pattern is found.
 */
export function detectStagnation(history: OuroborosHistory): StagnationDetection | null {
  const { outputHashes, driftScores } = history;

  if (outputHashes.length < MIN_HISTORY_FOR_DETECTION) {
    return null;
  }

  const detections: StagnationDetection[] = [];

  // 1. Spinning: last N hashes are identical
  if (outputHashes.length >= SPINNING_THRESHOLD) {
    const tail = outputHashes.slice(-SPINNING_THRESHOLD);
    const allSame = tail.every((h) => h === tail[0]);
    if (allSame) {
      detections.push({
        pattern: "spinning",
        confidence: 0.95,
        details: `Last ${SPINNING_THRESHOLD} outputs are identical (hash: ${tail[0]})`,
      });
    }
  }

  // 2. Oscillation: A-B-A-B pattern in recent hashes
  if (outputHashes.length >= OSCILLATION_WINDOW) {
    const window = outputHashes.slice(-OSCILLATION_WINDOW);
    const isOscillating =
      window.length >= 4 &&
      window[0] === window[2] &&
      window[1] === window[3] &&
      window[0] !== window[1];
    if (isOscillating) {
      detections.push({
        pattern: "oscillation",
        confidence: 0.9,
        details: `Oscillating between two states: ${window[0]} ↔ ${window[1]}`,
      });
    }
  }

  // 3. No drift: recent drift scores are all very low (but not identical outputs)
  if (driftScores.length >= NO_DRIFT_WINDOW) {
    const recentDrifts = driftScores.slice(-NO_DRIFT_WINDOW);
    const avgDrift = recentDrifts.reduce((a, b) => a + b, 0) / recentDrifts.length;
    if (avgDrift > 0 && avgDrift < NO_DRIFT_THRESHOLD) {
      detections.push({
        pattern: "no_drift",
        confidence: 0.8,
        details: `Average drift ${avgDrift.toFixed(4)} is below threshold ${NO_DRIFT_THRESHOLD}`,
      });
    }
  }

  // 4. Diminishing returns: drift scores trending toward zero
  if (driftScores.length >= DIMINISHING_RETURNS_WINDOW) {
    const window = driftScores.slice(-DIMINISHING_RETURNS_WINDOW);
    const first = window[0];
    const last = window[window.length - 1];
    if (first > 0 && last < first * DIMINISHING_RETURNS_RATIO) {
      detections.push({
        pattern: "diminishing_returns",
        confidence: 0.75,
        details: `Drift dropped from ${first.toFixed(4)} to ${last.toFixed(4)} (${((last / first) * 100).toFixed(1)}% of initial)`,
      });
    }
  }

  if (detections.length === 0) {
    return null;
  }

  // Return highest confidence detection
  detections.sort((a, b) => b.confidence - a.confidence);
  return detections[0];
}

// ---------------------------------------------------------------------------
// Persona selection
// ---------------------------------------------------------------------------

/**
 * Select the next persona to try based on stagnation pattern and already-applied personas.
 * Returns null if all 5 personas have been exhausted.
 */
export function selectPersona(
  pattern: StagnationPattern,
  appliedPersonas: string[],
): ThinkingPersona | null {
  const applied = new Set(appliedPersonas);

  // First try pattern-affine personas
  for (const persona of PERSONA_AFFINITY[pattern]) {
    if (!applied.has(persona)) {
      return persona;
    }
  }

  // Then try remaining personas in fixed order
  for (const persona of ALL_PERSONAS) {
    if (!applied.has(persona)) {
      return persona;
    }
  }

  // All exhausted
  return null;
}

/**
 * Get the prompt for a given persona.
 */
export function getPersonaPrompt(persona: ThinkingPersona): string {
  return PERSONA_PROMPTS[persona];
}

/**
 * Check if all personas have been exhausted.
 */
export function arePersonasExhausted(appliedPersonas: string[]): boolean {
  const applied = new Set(appliedPersonas);
  return ALL_PERSONAS.every((p) => applied.has(p));
}

/**
 * Create a fresh OuroborosHistory object.
 */
export function createEmptyHistory(): OuroborosHistory {
  return {
    outputHashes: [],
    driftScores: [],
    appliedPersonas: [],
  };
}

/**
 * Record a new output in the history, computing drift from the previous output.
 * Mutates and returns the history object.
 */
export function recordOutput(history: OuroborosHistory, outputContent: string): OuroborosHistory {
  const newHash = hashOutput(outputContent);
  const prevHash = history.outputHashes[history.outputHashes.length - 1];

  history.outputHashes.push(newHash);

  if (prevHash) {
    history.driftScores.push(computeDrift(prevHash, newHash));
  }

  // Keep history bounded (last 20 entries)
  const MAX_HISTORY = 20;
  if (history.outputHashes.length > MAX_HISTORY) {
    history.outputHashes = history.outputHashes.slice(-MAX_HISTORY);
  }
  if (history.driftScores.length > MAX_HISTORY - 1) {
    history.driftScores = history.driftScores.slice(-(MAX_HISTORY - 1));
  }

  return history;
}

/**
 * Full resilience check: detect stagnation, select persona, return prompt to inject.
 * Returns null if no stagnation detected or all personas exhausted.
 */
export function checkResilience(history: OuroborosHistory): {
  detection: StagnationDetection;
  persona: ThinkingPersona;
  prompt: string;
} | null {
  const detection = detectStagnation(history);
  if (!detection) {
    return null;
  }

  const persona = selectPersona(detection.pattern, history.appliedPersonas);
  if (!persona) {
    log.info("All personas exhausted, falling back to existing escalation", {
      pattern: detection.pattern,
      appliedPersonas: history.appliedPersonas,
    });
    return null;
  }

  log.info("Ouroboros resilience triggered", {
    pattern: detection.pattern,
    confidence: detection.confidence,
    persona,
    details: detection.details,
  });

  return {
    detection,
    persona,
    prompt: getPersonaPrompt(persona),
  };
}
