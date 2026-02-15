/**
 * Tier Config Resolution
 *
 * Resolves tier configuration from MemorySearchConfig with defaults.
 * Follows the same pattern as resolveMemorySearchConfig() in agents/memory-search.ts.
 */

import type { MemorySearchConfig } from "../config/types.tools.js";
import type { ResolvedTierConfig } from "./tier-types.js";

const DEFAULT_COMPRESSION_MIN_AGE_HOURS = 48;
const DEFAULT_COMPRESSION_MAX_TOKENS = 2000;

const DEFAULT_ARCHIVAL_NO_RECALL_HOURS = 336; // 14 days
const DEFAULT_ARCHIVAL_MAX_RECALL_COUNT = 1;
const DEFAULT_ARCHIVAL_RECALL_WINDOW_HOURS = 336;

const DEFAULT_PROMOTION_MIN_RECALL_COUNT = 3;
const DEFAULT_PROMOTION_RECALL_WINDOW_HOURS = 168; // 7 days
const DEFAULT_PROMOTION_COOLDOWN_HOURS = 72;

const DEFAULT_DELETION_NO_RECALL_HOURS = 2160; // 90 days
const DEFAULT_DELETION_NEVER_DELETE = true;

const DEFAULT_WEIGHT_T1 = 1.5;
const DEFAULT_WEIGHT_T2 = 1.0;
const DEFAULT_WEIGHT_T3 = 0.5;
const DEFAULT_WEIGHT_T4 = 1.2;

export function resolveTierConfig(
  defaults?: MemorySearchConfig,
  overrides?: MemorySearchConfig,
): ResolvedTierConfig {
  const dt = defaults?.tiers;
  const ot = overrides?.tiers;
  const enabled = ot?.enabled ?? dt?.enabled ?? false;

  const compression = {
    minAgeHours:
      ot?.compression?.minAgeHours ??
      dt?.compression?.minAgeHours ??
      DEFAULT_COMPRESSION_MIN_AGE_HOURS,
    maxCompressedTokens:
      ot?.compression?.maxCompressedTokens ??
      dt?.compression?.maxCompressedTokens ??
      DEFAULT_COMPRESSION_MAX_TOKENS,
    model: ot?.compression?.model ?? dt?.compression?.model,
    prompt: ot?.compression?.prompt ?? dt?.compression?.prompt,
  };

  const archival = {
    noRecallHours:
      ot?.archival?.noRecallHours ??
      dt?.archival?.noRecallHours ??
      DEFAULT_ARCHIVAL_NO_RECALL_HOURS,
    maxRecallCount:
      ot?.archival?.maxRecallCount ??
      dt?.archival?.maxRecallCount ??
      DEFAULT_ARCHIVAL_MAX_RECALL_COUNT,
    recallWindowHours:
      ot?.archival?.recallWindowHours ??
      dt?.archival?.recallWindowHours ??
      DEFAULT_ARCHIVAL_RECALL_WINDOW_HOURS,
  };

  const promotion = {
    minRecallCount:
      ot?.promotion?.minRecallCount ??
      dt?.promotion?.minRecallCount ??
      DEFAULT_PROMOTION_MIN_RECALL_COUNT,
    recallWindowHours:
      ot?.promotion?.recallWindowHours ??
      dt?.promotion?.recallWindowHours ??
      DEFAULT_PROMOTION_RECALL_WINDOW_HOURS,
    cooldownHours:
      ot?.promotion?.cooldownHours ??
      dt?.promotion?.cooldownHours ??
      DEFAULT_PROMOTION_COOLDOWN_HOURS,
  };

  const deletion = {
    noRecallHours:
      ot?.deletion?.noRecallHours ??
      dt?.deletion?.noRecallHours ??
      DEFAULT_DELETION_NO_RECALL_HOURS,
    neverDelete: ot?.deletion?.neverDelete ?? dt?.deletion?.neverDelete ?? DEFAULT_DELETION_NEVER_DELETE,
  };

  const searchWeights = {
    t1: ot?.searchWeights?.t1 ?? dt?.searchWeights?.t1 ?? DEFAULT_WEIGHT_T1,
    t2: ot?.searchWeights?.t2 ?? dt?.searchWeights?.t2 ?? DEFAULT_WEIGHT_T2,
    t3: ot?.searchWeights?.t3 ?? dt?.searchWeights?.t3 ?? DEFAULT_WEIGHT_T3,
    t4: ot?.searchWeights?.t4 ?? dt?.searchWeights?.t4 ?? DEFAULT_WEIGHT_T4,
  };

  return { enabled, compression, archival, promotion, deletion, searchWeights };
}
