/**
 * @module attention
 * Barrel export for the Aether Attention Architecture — Phase 2.
 *
 * Exports the deterministic TypeScript layer:
 *   - mode-detector:    5-tier priority cascade with hysteresis
 *   - salience-scorer:  6-dimension heuristic scoring with sigmoid
 *   - feedback-tracker: 6-type feedback state machine with JSONL persistence
 *   - types:            Shared AttentionConfig interface
 *
 * All components are pure TypeScript — no LLM calls, no external API calls.
 * Side effects are limited to feedback-tracker (file I/O for the JSONL log).
 *
 * @example
 * ```typescript
 * import { detectMode, scoreEvent, recordFeedback } from './attention/index.js';
 * import type { AttentionConfig } from './attention/index.js';
 * ```
 */

export * from "./mode-detector.js";
export * from "./salience-scorer.js";
export * from "./feedback-tracker.js";
export type { AttentionConfig } from "./types.js";
