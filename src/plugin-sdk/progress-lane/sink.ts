/**
 * Channel-agnostic progress-lane contract.
 *
 * The shared engine (`controller.ts`) ingests an agent's reasoning/tool/event
 * stream into the transcript model and produces a neutral body string. Each
 * channel implements `ProgressLaneSink` to format that body to its surface and
 * edit its durable progress message over its existing draft-stream; the shared
 * `src/channels/draft-stream-loop.ts` throttle stays underneath every sink.
 *
 * Text channels (Telegram HTML, Discord markdown) format the body directly.
 * Card channels (MSTeams Adaptive Cards, Feishu cards) wrap it in a text block
 * for now; emitting structured segments for richer card rows is a follow-up
 * (the transcript model already separates reasoning lines from `[ts] tool`
 * rows, so segmentation is mechanical when wanted).
 */

/** Superset config — the union of Telegram (#87072) + Discord (#85200) options,
 * reconciled into the `streaming.progress.*` namespace. Nothing is dropped. */
export interface ProgressLaneConfig {
  /** Master gate; inherits the channel's existing group/DM/visibility gating. */
  enabled: boolean;
  /** Render the model's reasoning (Telegram interleaved). */
  reasoning: boolean;
  /** Render intermediate assistant commentary (Discord #85200). Off keeps reply
   * prose out of the lane — the #87072 behavior. */
  commentary: boolean;
  /** Render `[HH:MM:SS] tool` rows. */
  toolRows: boolean;
  /** Show sanitized tool args/command, not just the tool name. */
  toolArgs: boolean;
  /** Show the rolling "still running" timer + wall-clock stamp. */
  timer: boolean;
  /** Timer tick cadence (ms) — per channel so concurrent messages stay under
   * the channel edit-rate (Telegram 20_000 to avoid 429s). */
  timerIntervalMs: number;
  /** Header for the durable message (defaults to "Thinking"). */
  header?: string;
}

/** A channel's adapter. The engine produces a neutral body; the sink formats +
 * edits the durable message. `maxChars` drives per-channel rollover. */
export interface ProgressLaneSink {
  /** Per-message character budget for the rollover computation
   * (Telegram 4096, Discord 2000, card limits). */
  readonly maxChars: number;
  /** Format the engine's neutral body to the channel surface
   * (Telegram HTML, Discord markdown, card payload). */
  render(body: string): string;
  /** Edit the durable progress message with the rendered text (throttled by the
   * shared draft-stream loop). */
  update(rendered: string): void;
  /** Start a fresh continuation message (the channel's `forceNewMessage`), used
   * when the body would outgrow `maxChars`. */
  spill(): void;
}
