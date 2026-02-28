/**
 * IBEL Phase 1 — Instruction level hierarchy utilities.
 */

import { InstructionLevel } from "./types.js";

const LEVEL_LABELS: Record<InstructionLevel, string> = {
  [InstructionLevel.SYSTEM]: "SYSTEM",
  [InstructionLevel.POLICY]: "POLICY",
  [InstructionLevel.TASK]: "TASK",
  [InstructionLevel.USER]: "USER",
  [InstructionLevel.EXTERNAL_CONTENT]: "EXTERNAL_CONTENT",
};

/**
 * Returns true if `source` has equal or higher privilege than `target`
 * (i.e. source can override target).
 */
export function canOverride(source: InstructionLevel, target: InstructionLevel): boolean {
  return source <= target;
}

/**
 * Returns the least-privileged (highest numeric value) level from the inputs.
 * This is the conservative choice: when combining data from multiple sources,
 * the result inherits the worst-case privilege.
 */
export function worstCaseLevel(...levels: InstructionLevel[]): InstructionLevel {
  if (levels.length === 0) {
    return InstructionLevel.SYSTEM;
  }
  let worst = levels[0];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > worst) {
      worst = levels[i];
    }
  }
  return worst;
}

/**
 * Returns true if the level represents untrusted external content.
 */
export function isUntrusted(level: InstructionLevel): boolean {
  return level === InstructionLevel.EXTERNAL_CONTENT;
}

/**
 * Returns a human-readable label for the given instruction level.
 */
export function levelLabel(level: InstructionLevel): string {
  return LEVEL_LABELS[level] ?? `UNKNOWN(${level})`;
}
