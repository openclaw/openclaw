/**
 * Multiplex control channel — Phase B.4.
 *
 * Backpressure + lightweight control plane that rides on streamId 0
 * (CONTROL) of the multiplex transport. Messages are UTF-8 JSON
 * payloads with a discriminator `type` field.
 *
 * Supported message types:
 *   - "backpressure" — `{ level: "high" | "low", bufferedBytes?, queuedFrames? }`
 *     Notifies the peer that the local outbound buffer is full ("high")
 *     or has drained below the resume threshold ("low").
 *   - "pause" / "resume" — `{ streamId?: number }`
 *     Requests peer to pause / resume a specific stream (or all if
 *     `streamId` omitted).
 *   - "error" — `{ code: string, message: string, streamId?: number }`
 *     Surfaces a stream-level error to the peer.
 *   - "ack" — `{ forType: string, ... }`
 *     Optional ack for any of the above.
 *
 * Unknown types are surfaced via {@link MultiplexControlChannelOptions.onUnknown}
 * to keep the channel forward-compatible.
 */
import {
  encodeMultiplexFrame,
  MULTIPLEX_FLAG_PRIORITY,
  MULTIPLEX_STREAM,
  type MultiplexFrame,
} from "./multiplex-frame.js";

/** All built-in control message types. */
export type ControlMessageType = "backpressure" | "pause" | "resume" | "error" | "ack";

/** Backpressure levels. */
export type BackpressureLevel = "high" | "low";

/** Backpressure message payload. */
export interface BackpressureMessage {
  type: "backpressure";
  level: BackpressureLevel;
  bufferedBytes?: number;
  queuedFrames?: number;
  /** Optional per-stream scope (omit for connection-wide). */
  streamId?: number;
}

/** Pause / resume message payload. */
export interface PauseResumeMessage {
  type: "pause" | "resume";
  streamId?: number;
}

/** Error message payload. */
export interface ControlErrorMessage {
  type: "error";
  code: string;
  message: string;
  streamId?: number;
}

/** Ack message payload. */
export interface ControlAckMessage {
  type: "ack";
  forType: string;
  [extra: string]: unknown;
}

/** Union of well-known control messages. */
export type KnownControlMessage =
  | BackpressureMessage
  | PauseResumeMessage
  | ControlErrorMessage
  | ControlAckMessage;

/** Send callback — receives an encoded multiplex frame ready for the wire. */
export type ControlSend = (frame: Buffer) => void;

export interface MultiplexControlChannelOptions {
  /** Required: how to deliver an encoded multiplex frame to the peer. */
  send: ControlSend;
  /** Called when a "backpressure" message is received from the peer. */
  onBackpressure?: (msg: BackpressureMessage) => void;
  /** Called when a "pause" message is received from the peer. */
  onPause?: (msg: PauseResumeMessage) => void;
  /** Called when a "resume" message is received from the peer. */
  onResume?: (msg: PauseResumeMessage) => void;
  /** Called when an "error" message is received from the peer. */
  onError?: (msg: ControlErrorMessage) => void;
  /** Called when an "ack" message is received from the peer. */
  onAck?: (msg: ControlAckMessage) => void;
  /** Called when an unknown / future-spec type is received. */
  onUnknown?: (raw: Record<string, unknown>) => void;
  /**
   * Called when an inbound control frame can't be parsed (invalid JSON
   * or non-object payload). Defaults to silently dropping.
   */
  onParseError?: (error: Error, frame: MultiplexFrame) => void;
}

const ENCODER = new TextEncoder();

function encodeJsonFrame(payload: object, flags = 0): Buffer {
  // Control frames are always priority — they should jump ahead of bulk
  // audio/video traffic at the WS scheduler level.
  return encodeMultiplexFrame(
    MULTIPLEX_STREAM.CONTROL,
    Buffer.from(ENCODER.encode(JSON.stringify(payload))),
    flags | MULTIPLEX_FLAG_PRIORITY,
  );
}

/**
 * Per-session control channel.
 */
export class MultiplexControlChannel {
  /** Stream id this channel uses. */
  static readonly STREAM_ID = MULTIPLEX_STREAM.CONTROL;

  private readonly send: ControlSend;
  private readonly opts: MultiplexControlChannelOptions;
  private framesSent = 0;
  private framesReceived = 0;
  private parseErrors = 0;
  /** Local view: did we last send "high" or "low" backpressure? */
  private lastSentBackpressureLevel: BackpressureLevel | null = null;
  /** Peer's last reported backpressure level (or null if never). */
  private lastReceivedBackpressureLevel: BackpressureLevel | null = null;

  constructor(options: MultiplexControlChannelOptions) {
    if (typeof options.send !== "function") {
      throw new TypeError("MultiplexControlChannel requires a send callback");
    }
    this.send = options.send;
    this.opts = options;
  }

  /** Telemetry snapshot. */
  get stats(): {
    framesSent: number;
    framesReceived: number;
    parseErrors: number;
    lastSentBackpressureLevel: BackpressureLevel | null;
    lastReceivedBackpressureLevel: BackpressureLevel | null;
  } {
    return {
      framesSent: this.framesSent,
      framesReceived: this.framesReceived,
      parseErrors: this.parseErrors,
      lastSentBackpressureLevel: this.lastSentBackpressureLevel,
      lastReceivedBackpressureLevel: this.lastReceivedBackpressureLevel,
    };
  }

  // ---- Outbound -----------------------------------------------------------

  /**
   * Notify peer of a backpressure transition. Only emits a frame when the
   * level actually changed (idempotent), so it's safe to call from a
   * `socket.bufferedAmount` watchdog every tick.
   */
  sendBackpressure(
    level: BackpressureLevel,
    extras?: { bufferedBytes?: number; queuedFrames?: number; streamId?: number; force?: boolean },
  ): boolean {
    const force = extras?.force === true;
    if (!force && this.lastSentBackpressureLevel === level) {
      return false;
    }
    const msg: BackpressureMessage = {
      type: "backpressure",
      level,
      ...(extras?.bufferedBytes !== undefined ? { bufferedBytes: extras.bufferedBytes } : {}),
      ...(extras?.queuedFrames !== undefined ? { queuedFrames: extras.queuedFrames } : {}),
      ...(extras?.streamId !== undefined ? { streamId: extras.streamId } : {}),
    };
    this.send(encodeJsonFrame(msg));
    this.framesSent++;
    this.lastSentBackpressureLevel = level;
    return true;
  }

  /** Send a pause request (optionally scoped to one streamId). */
  sendPause(streamId?: number): void {
    const msg: PauseResumeMessage = { type: "pause", ...(streamId !== undefined ? { streamId } : {}) };
    this.send(encodeJsonFrame(msg));
    this.framesSent++;
  }

  /** Send a resume request (optionally scoped to one streamId). */
  sendResume(streamId?: number): void {
    const msg: PauseResumeMessage = { type: "resume", ...(streamId !== undefined ? { streamId } : {}) };
    this.send(encodeJsonFrame(msg));
    this.framesSent++;
  }

  /** Surface a stream-level error to the peer. */
  sendError(code: string, message: string, streamId?: number): void {
    const msg: ControlErrorMessage = {
      type: "error",
      code,
      message,
      ...(streamId !== undefined ? { streamId } : {}),
    };
    this.send(encodeJsonFrame(msg));
    this.framesSent++;
  }

  /** Send an ack for a given prior message. */
  sendAck(forType: string, extras?: Record<string, unknown>): void {
    const msg: ControlAckMessage = {
      type: "ack",
      forType,
      ...extras,
    };
    this.send(encodeJsonFrame(msg));
    this.framesSent++;
  }

  // ---- Inbound ------------------------------------------------------------

  /**
   * Frame handler suitable for direct registration with a
   * {@link MultiplexDemuxer} (`demux.on(MULTIPLEX_STREAM.CONTROL, ch.handleFrame)`).
   * Bound to `this`.
   */
  readonly handleFrame = (frame: MultiplexFrame): void => {
    if (frame.streamId !== MULTIPLEX_STREAM.CONTROL) {
      return;
    }
    this.framesReceived++;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(frame.payload.toString("utf8"));
    } catch (err) {
      this.parseErrors++;
      this.opts.onParseError?.(
        err instanceof Error ? err : new Error(String(err)),
        frame,
      );
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.parseErrors++;
      this.opts.onParseError?.(
        new Error("control payload must be a JSON object"),
        frame,
      );
      return;
    }

    const obj: Record<string, unknown> = parsed;
    const type = typeof obj.type === "string" ? obj.type : undefined;
    switch (type) {
      case "backpressure": {
        const level = obj.level === "high" || obj.level === "low" ? obj.level : null;
        if (!level) {
          this.opts.onParseError?.(
            new Error("backpressure message missing level"),
            frame,
          );
          return;
        }
        const msg: BackpressureMessage = {
          type: "backpressure",
          level,
          ...(typeof obj.bufferedBytes === "number" ? { bufferedBytes: obj.bufferedBytes } : {}),
          ...(typeof obj.queuedFrames === "number" ? { queuedFrames: obj.queuedFrames } : {}),
          ...(typeof obj.streamId === "number" ? { streamId: obj.streamId } : {}),
        };
        this.lastReceivedBackpressureLevel = level;
        this.opts.onBackpressure?.(msg);
        return;
      }
      case "pause":
      case "resume": {
        const msg: PauseResumeMessage = {
          type,
          ...(typeof obj.streamId === "number" ? { streamId: obj.streamId } : {}),
        };
        if (type === "pause") {
          this.opts.onPause?.(msg);
        } else {
          this.opts.onResume?.(msg);
        }
        return;
      }
      case "error": {
        const code = typeof obj.code === "string" ? obj.code : "UNKNOWN";
        const message = typeof obj.message === "string" ? obj.message : "";
        const msg: ControlErrorMessage = {
          type: "error",
          code,
          message,
          ...(typeof obj.streamId === "number" ? { streamId: obj.streamId } : {}),
        };
        this.opts.onError?.(msg);
        return;
      }
      case "ack": {
        const forType = typeof obj.forType === "string" ? obj.forType : "unknown";
        const msg: ControlAckMessage = { ...obj, type: "ack", forType };
        this.opts.onAck?.(msg);
        return;
      }
      default: {
        this.opts.onUnknown?.(obj);
        return;
      }
    }
  };
}

export const CONTROL_STREAM_ID = MULTIPLEX_STREAM.CONTROL;

/**
 * Helper: drive backpressure transitions from a numeric watermark.
 *
 * Returns the backpressure level to send (or null if no change required).
 * Use to wrap a `socket.bufferedAmount` poll.
 */
export function computeBackpressureLevel(
  current: number,
  highWatermark: number,
  lowWatermark: number,
  previousLevel: BackpressureLevel | null,
): BackpressureLevel | null {
  if (current >= highWatermark && previousLevel !== "high") {
    return "high";
  }
  if (current <= lowWatermark && previousLevel === "high") {
    return "low";
  }
  return null;
}
