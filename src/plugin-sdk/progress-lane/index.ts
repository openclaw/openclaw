/**
 * Shared progress-lane engine — public entry.
 *
 * Channels import the engine from `openclaw/plugin-sdk/progress-lane`:
 *   import { createProgressLane, type ProgressLaneSink } from "openclaw/plugin-sdk/progress-lane";
 * implement a thin `ProgressLaneSink` over their existing draft-stream, and wire
 * the generic agent callbacks to the returned handle. See ./README.md.
 */
export { createProgressLane, type ProgressLane } from "./controller.js";
export type { ProgressLaneConfig, ProgressLaneSink } from "./sink.js";
export {
  appendLaneDelta,
  appendStatusLine,
  computeSpill,
  emptyLaneStreamState,
  LANE_MESSAGE_MAX_CHARS,
  LANE_SPILL_OVERLAP_CHARS,
  LANE_TIMER_INTERVAL_MS,
  type LaneStreamState,
  renderLaneBody,
  resolveLaneToolLine,
  sanitizeLaneLine,
  stripFinalAnswerFromBody,
} from "./transcript.js";
