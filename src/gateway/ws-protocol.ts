export interface WebSocketProtocolConfig {
  allowedSubprotocols: readonly string[];
  requiredSubprotocol?: string;
  rejectUnknownProtocols: boolean;
}

export const DEFAULT_PROTOCOL_CONFIG: WebSocketProtocolConfig = {
  allowedSubprotocols: ["openclaw-gateway-v1"],
  requiredSubprotocol: "openclaw-gateway-v1",
  rejectUnknownProtocols: true,
};

export interface FrameLimits {
  maxFrameSize: number;
  maxMessageSize: number;
  maxQueueSize: number;
  maxFramesPerSecond: number;
  maxMessagesPerSecond: number;
}

export const DEFAULT_FRAME_LIMITS: FrameLimits = {
  maxFrameSize: 16 * 1024,
  maxMessageSize: 1024 * 1024,
  maxQueueSize: 100,
  maxFramesPerSecond: 1000,
  maxMessagesPerSecond: 500,
};

export interface ProtocolNegotiationResult {
  ok: true;
  protocol: string;
}
export interface ProtocolNegotiationError {
  ok: false;
  reason: string;
}
export type ProtocolNegotiation = ProtocolNegotiationResult | ProtocolNegotiationError;

export function negotiateProtocol(
  clientProtocols: string | string[] | undefined,
  config: WebSocketProtocolConfig,
): ProtocolNegotiation {
  if (!clientProtocols) {
    if (config.requiredSubprotocol) {
      return {
        ok: false,
        reason: "no subprotocol specified, required: " + config.requiredSubprotocol,
      };
    }
    return { ok: true, protocol: "" };
  }

  const clientList = Array.isArray(clientProtocols)
    ? clientProtocols
    : clientProtocols.split(",").map((p) => p.trim());

  const allowedSet = new Set(config.allowedSubprotocols.map((p) => p.toLowerCase()));

  for (const proto of clientList) {
    const normalized = proto.toLowerCase();
    if (allowedSet.has(normalized)) {
      return { ok: true, protocol: proto };
    }
  }

  if (config.rejectUnknownProtocols) {
    return {
      ok: false,
      reason: `unknown protocol, allowed: ${config.allowedSubprotocols.join(", ")}`,
    };
  }

  return { ok: true, protocol: "" };
}

export interface RateLimiterState {
  frameCount: number;
  messageCount: number;
  windowStart: number;
}

export function createRateLimiterState(): RateLimiterState {
  return {
    frameCount: 0,
    messageCount: 0,
    windowStart: Date.now(),
  };
}

export function checkRateLimit(
  state: RateLimiterState,
  limits: FrameLimits,
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  const windowElapsed = now - state.windowStart;

  if (windowElapsed >= 1000) {
    state.frameCount = 0;
    state.messageCount = 0;
    state.windowStart = now;
    return { ok: true };
  }

  if (state.frameCount >= limits.maxFramesPerSecond) {
    return { ok: false, reason: "frame rate limit exceeded" };
  }

  if (state.messageCount >= limits.maxMessagesPerSecond) {
    return { ok: false, reason: "message rate limit exceeded" };
  }

  state.frameCount++;
  state.messageCount++;

  return { ok: true };
}

export interface QueueEntry {
  data: Buffer | ArrayBuffer;
  opcode: number;
  timestamp: number;
}

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private readonly maxSize: number;
  private readonly maxSizeBytes: number;
  private currentBytes = 0;

  constructor(maxSize: number = 100, maxSizeBytes: number = 10 * 1024 * 1024) {
    this.maxSize = maxSize;
    this.maxSizeBytes = maxSizeBytes;
  }

  enqueue(
    data: Buffer | ArrayBuffer,
    opcode: number,
  ): { ok: true } | { ok: false; reason: string } {
    const dataBytes = data instanceof Buffer ? data.length : data.byteLength;

    if (this.queue.length >= this.maxSize) {
      return { ok: false, reason: "queue full (max messages)" };
    }

    if (this.currentBytes + dataBytes > this.maxSizeBytes) {
      return { ok: false, reason: "queue full (max bytes)" };
    }

    this.queue.push({
      data,
      opcode,
      timestamp: Date.now(),
    });
    this.currentBytes += dataBytes;

    return { ok: true };
  }

  dequeue(): QueueEntry | undefined {
    const entry = this.queue.shift();
    if (entry) {
      const dataBytes = entry.data instanceof Buffer ? entry.data.length : entry.data.byteLength;
      this.currentBytes -= dataBytes;
    }
    return entry;
  }

  clear(): void {
    this.queue = [];
    this.currentBytes = 0;
  }

  size(): number {
    return this.queue.length;
  }

  bytes(): number {
    return this.currentBytes;
  }
}
