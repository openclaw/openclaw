/**
 * Channel-agnostic progress-lane contract.
 *
 * The shared engine (`controller.ts`) ingests an agent's reasoning/tool/event
 * stream into a transcript model and emits `LaneSegment[]`. Each channel
 * implements `ProgressLaneSink` to render those segments to its own format and
 * edit its durable progress message over its existing draft-stream. The shared
 * `src/channels/draft-stream-loop.ts` throttle stays underneath every sink.
 *
 * Structured segments (not pre-rendered markdown) are the contract so that
 * card-based channels (MSTeams Adaptive Cards, Feishu cards) can render to card
 * blocks, while text channels (Telegram HTML, Discord markdown) flatten them.
 */

/** One rendered unit of the live progress transcript. */
export type LaneSegment =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; detail?: string; timestamp?: string }
  | { kind: "event"; title: string; timestamp?: string }
  | { kind: "timer"; elapsedSeconds: number; clock: string };

/** Superset config — the union of Telegram (#87072) + Discord (#85200) options.
 * Reconciled into the `streaming.progress.*` namespace; the engine reads it and
 * channels stop diverging. Nothing from either side is dropped. */
export interface ProgressLaneConfig {
  /** Master gate — inherits the channel's existing group/DM/visibility gating. */
  enabled: boolean;
  /** Render the model's reasoning (Telegram interleaved). */
  reasoning: boolean;
  /** Render intermediate assistant commentary (Discord #85200). */
  commentary: boolean;
  /** Render `[HH:MM:SS] tool` rows. */
  toolRows: boolean;
  /** Show the sanitized tool args/command, not just the tool name. */
  toolArgs: boolean;
  /** Show the rolling "still running" timer + wall-clock stamp. */
  timer: boolean;
  /** Timer tick cadence (ms). Per-channel so concurrent messages stay under the
   * channel's edit-rate limit (Telegram: 20_000 to avoid 429s). */
  timerIntervalMs: number;
}

/**
 * A channel's adapter. The engine calls `render` to format segments, then
 * `update`/`spill` to drive the channel's durable message. `maxChars` lets the
 * shared `computeSpill` decide rollover per channel (Telegram 4096, Discord
 * 2000, card limits for Teams/Feishu).
 */
export interface ProgressLaneSink {
  /** The channel's per-message character budget (used by the spill computation). */
  readonly maxChars: number;
  /** Render the current transcript segments to the channel's format
   * (Telegram HTML / Discord markdown / Teams|Feishu card payload). */
  render(segments: LaneSegment[]): string;
  /** Edit the durable progress message with the rendered text. Throttled by the
   * shared draft-stream loop. */
  update(rendered: string): void;
  /** Start a fresh continuation message (the channel's `forceNewMessage`), used
   * when the message would outgrow `maxChars`. */
  spill(): void;
}
