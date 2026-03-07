const ZOMBIE_RECONNECT_FRAGMENT =
  "Attempted to reconnect zombie connection after disconnecting first";
const RECONNECT_EXHAUSTION_FRAGMENT = "Max reconnect attempts";

const DEFAULT_STALL_THRESHOLD = 2;
const DEFAULT_STALL_WINDOW_MS = 5 * 60_000;

export function shouldRestartDiscordGatewayProcessForError(err: unknown): boolean {
  const message = String(err);
  return (
    message.includes(ZOMBIE_RECONNECT_FRAGMENT) || message.includes(RECONNECT_EXHAUSTION_FRAGMENT)
  );
}

export function createDiscordGatewayWatchdog(params?: {
  now?: () => number;
  stallThreshold?: number;
  stallWindowMs?: number;
}) {
  const now = params?.now ?? (() => Date.now());
  const stallThreshold = Math.max(1, params?.stallThreshold ?? DEFAULT_STALL_THRESHOLD);
  const stallWindowMs = Math.max(1_000, params?.stallWindowMs ?? DEFAULT_STALL_WINDOW_MS);
  let helloStallTimestamps: number[] = [];

  const prune = (currentTs: number) => {
    helloStallTimestamps = helloStallTimestamps.filter((ts) => currentTs - ts <= stallWindowMs);
  };

  return {
    recordHelloTimeout() {
      const currentTs = now();
      prune(currentTs);
      helloStallTimestamps.push(currentTs);
      return helloStallTimestamps.length >= stallThreshold;
    },
    resetHelloTimeouts() {
      helloStallTimestamps = [];
    },
    getHelloTimeoutCount() {
      prune(now());
      return helloStallTimestamps.length;
    },
  };
}
