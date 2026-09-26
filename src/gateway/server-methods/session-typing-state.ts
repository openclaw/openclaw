import { listSystemPresence } from "../../infra/system-presence.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { presenceUserKey } from "../../shared/presence-user.js";

export const TYPING_THROTTLE_MS = 1_000;
export const TYPING_PREVIEW_THROTTLE_MS = 250;
const TYPING_ACTIVE_TTL_MS = 2_500;
const MAX_TYPING_THROTTLE_KEYS = 2_048;
type PendingTypingBroadcast = {
  signature: string;
  intervalMs: number;
  emit: () => boolean;
};
type TypingBroadcastState = {
  at: number;
  signature: string;
  pending?: PendingTypingBroadcast;
  timer?: ReturnType<typeof setTimeout>;
};
type TypingConnectionState = { updatedAt: number; preview?: string };
type TypingConnections = {
  connections: Map<string, TypingConnectionState>;
  timer: ReturnType<typeof setTimeout>;
};

type SessionTypingState = {
  broadcasts: Map<string, TypingBroadcastState>;
  connections: Map<string, TypingConnections>;
};

function clearSessionTypingStateValue(state: SessionTypingState): void {
  for (const entry of state.broadcasts.values()) {
    clearTimeout(entry.timer);
  }
  state.broadcasts.clear();
  for (const entry of state.connections.values()) {
    clearTimeout(entry.timer);
  }
  state.connections.clear();
}

const sessionTypingState = resolveGlobalSingleton<SessionTypingState>(
  Symbol.for("openclaw.sessionTypingState"),
  () => ({ broadcasts: new Map(), connections: new Map() }),
  clearSessionTypingStateValue,
);
const typingBroadcastState = sessionTypingState.broadcasts;
const typingConnections = sessionTypingState.connections;

export function clearSessionTypingState(): void {
  clearSessionTypingStateValue(sessionTypingState);
}

export function liveViewerIdentities(sessionKeys: ReadonlySet<string>): Set<string> {
  return new Set(
    listSystemPresence().flatMap((entry) =>
      entry.user?.id && entry.watchedSessions?.some((sessionKey) => sessionKeys.has(sessionKey))
        ? [presenceUserKey(entry.user)]
        : [],
    ),
  );
}

function rememberTypingBroadcast(key: string, state: TypingBroadcastState): void {
  typingBroadcastState.delete(key);
  typingBroadcastState.set(key, state);
  if (typingBroadcastState.size <= MAX_TYPING_THROTTLE_KEYS) {
    return;
  }
  const oldestKey = typingBroadcastState.keys().next().value;
  if (!oldestKey) {
    return;
  }
  clearTimeout(typingBroadcastState.get(oldestKey)?.timer);
  typingBroadcastState.delete(oldestKey);
}

export function broadcastTypingThrottled(params: {
  key: string;
  typing: boolean;
  signature: string;
  intervalMs: number;
  now: number;
  emit: () => boolean;
}): boolean {
  const previous = typingBroadcastState.get(params.key);
  if (!previous || params.now - previous.at >= params.intervalMs) {
    clearTimeout(previous?.timer);
    const emitted = params.emit();
    rememberTypingBroadcast(params.key, {
      at: params.now,
      signature: params.signature,
    });
    return emitted;
  }

  if (params.signature === previous.signature && previous.pending?.signature !== params.signature) {
    clearTimeout(previous.timer);
    delete previous.pending;
    delete previous.timer;
    if (!params.typing) {
      rememberTypingBroadcast(params.key, previous);
      return false;
    }
  }

  if (previous.timer && previous.pending?.intervalMs !== params.intervalMs) {
    clearTimeout(previous.timer);
    delete previous.timer;
  }
  previous.pending = {
    signature: params.signature,
    intervalMs: params.intervalMs,
    emit: params.emit,
  };
  if (!previous.timer) {
    const timer = setTimeout(
      () => {
        const current = typingBroadcastState.get(params.key);
        if (!current || current.timer !== timer || !current.pending) {
          return;
        }
        const pending = current.pending;
        const next = {
          at: Date.now(),
          signature: pending.signature,
        } satisfies TypingBroadcastState;
        pending.emit();
        rememberTypingBroadcast(params.key, next);
      },
      params.intervalMs - (params.now - previous.at),
    );
    timer.unref?.();
    previous.timer = timer;
  }
  rememberTypingBroadcast(params.key, previous);
  return false;
}

export function updateTypingConnections(params: {
  key: string;
  connectionId: string;
  typing: boolean;
  preview?: string;
  now: number;
}): { typing: boolean; preview?: string } {
  let bucket = typingConnections.get(params.key);
  if (!bucket) {
    if (!params.typing) {
      return { typing: false };
    }
    const timer = setTimeout(() => {
      typingConnections.delete(params.key);
    }, TYPING_ACTIVE_TTL_MS);
    timer.unref?.();
    bucket = { connections: new Map(), timer };
  }
  const { connections } = bucket;
  if (params.typing) {
    bucket.timer.refresh();
    connections.set(params.connectionId, {
      updatedAt: params.now,
      ...(params.preview ? { preview: params.preview } : {}),
    });
  } else {
    connections.delete(params.connectionId);
  }
  let latestPreview: TypingConnectionState | undefined;
  for (const [connectionId, connection] of connections) {
    if (params.now - connection.updatedAt >= TYPING_ACTIVE_TTL_MS) {
      connections.delete(connectionId);
    } else if (
      connection.preview &&
      (!latestPreview || connection.updatedAt >= latestPreview.updatedAt)
    ) {
      latestPreview = connection;
    }
  }
  if (connections.size === 0) {
    clearTimeout(bucket.timer);
    typingConnections.delete(params.key);
    return { typing: false };
  }
  typingConnections.delete(params.key);
  typingConnections.set(params.key, bucket);
  if (typingConnections.size > MAX_TYPING_THROTTLE_KEYS) {
    const oldestKey = typingConnections.keys().next().value;
    if (oldestKey !== undefined) {
      clearTimeout(typingConnections.get(oldestKey)?.timer);
      typingConnections.delete(oldestKey);
    }
  }
  return { typing: true, ...(latestPreview?.preview ? { preview: latestPreview.preview } : {}) };
}
