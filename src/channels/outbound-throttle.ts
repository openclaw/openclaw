/**
 * Per-key outbound throttle: serializes sends per chat/channel and enforces
 * a minimum delay between completions to avoid platform rate limits (e.g.
 * Telegram 1 msg/s per chat, Discord 5 msg/5s per channel).
 */

type Pending = {
  resolve: () => void;
  runAt: number;
};

export class OutboundThrottle {
  private readonly delayMs: number;
  private lastDoneAt = 0;
  private queue: Pending[] = [];
  /** True while a run() is executing fn(); blocks concurrent run() from starting. */
  private inFlight = false;
  /** Single timer for the next drain; prevents duplicate timers for the same head. */
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(delayMs: number) {
    this.delayMs = Math.max(0, Math.floor(delayMs));
  }

  /**
   * Run the given send function after the throttle delay for this key.
   * Serializes concurrent calls per key; each completion enforces delay before the next.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const waitUntil = Math.max(now, this.lastDoneAt + this.delayMs);
    const mustWait =
      this.inFlight ||
      this.queue.length > 0 ||
      (this.lastDoneAt > 0 && now < this.lastDoneAt + this.delayMs);
    if (mustWait) {
      await new Promise<void>((resolve) => {
        this.queue.push({ resolve, runAt: waitUntil });
        this.drain();
      });
    }
    this.inFlight = true;
    try {
      return await fn();
    } finally {
      this.inFlight = false;
      this.lastDoneAt = Date.now();
      this.drain();
    }
  }

  private drain(): void {
    if (this.queue.length === 0) {
      return;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    const now = Date.now();
    const next = this.queue[0];
    const waitUntil = Math.max(next.runAt, this.lastDoneAt + this.delayMs);
    const waitMs = Math.max(0, waitUntil - now);
    if (waitMs > 0) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.queue[0] !== next) {
          return;
        }
        this.queue.shift();
        next.resolve();
        this.lastDoneAt = Date.now();
        this.drain();
      }, waitMs);
      return;
    }
    this.queue.shift();
    next.resolve();
    this.lastDoneAt = now;
    this.drain();
  }
}

const throttleByChannel = new Map<string, Map<string, OutboundThrottle>>();

function getThrottleForChannel(channelId: string, key: string, delayMs: number): OutboundThrottle {
  let byKey = throttleByChannel.get(channelId);
  if (!byKey) {
    byKey = new Map();
    throttleByChannel.set(channelId, byKey);
  }
  let throttle = byKey.get(key);
  if (!throttle) {
    throttle = new OutboundThrottle(delayMs);
    byKey.set(key, throttle);
  }
  return throttle;
}

/**
 * Run an outbound send through the per-channel, per-key throttle.
 * Use the same key for a given chat/channel so multiple messages are serialized with delay.
 *
 * @param channelId - Channel identifier (e.g. "telegram", "discord", "slack")
 * @param key - Per-destination key (e.g. chatId or channelId)
 * @param delayMs - Minimum ms between completions (from config)
 * @param fn - The actual send function
 */
export async function withOutboundThrottle<T>(
  channelId: string,
  key: string,
  delayMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (delayMs <= 0) {
    return await fn();
  }
  const throttle = getThrottleForChannel(channelId, key, delayMs);
  return await throttle.run(key, fn);
}
