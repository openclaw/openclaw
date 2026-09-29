import crypto from "node:crypto";

export type OneTimeTicketStore<T> = {
  mint(
    payload: T,
    opts?: { ttlMs?: number; nowMs?: number; revokeSignal?: AbortSignal },
  ): { token: string; expiresAtMs: number };
  /** Single use; a rejected owner check leaves an unexpired ticket available to its owner. */
  consume(token: string, nowMs?: number, accept?: (payload: T) => boolean): T | undefined;
  /** Drops a ticket without redeeming or expiring it (no `onExpire`). */
  delete(token: string): boolean;
  clear(): void;
  readonly size: number;
};

export function createOneTimeTicketStore<T>(opts: {
  ttlMs: number;
  now?: () => number;
  /** Called when an unconsumed ticket expires through its timer, consume() or clear(). */
  onExpire?: (payload: T, token: string) => void;
}): OneTimeTicketStore<T> {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<
    string,
    {
      payload: T;
      expiresAtMs: number;
      timer: ReturnType<typeof setTimeout>;
      revokeSignal?: AbortSignal;
      onRevoke: () => void;
    }
  >();
  const remove = (token: string) => {
    const entry = entries.get(token);
    if (entry) {
      entries.delete(token);
      clearTimeout(entry.timer);
      entry.revokeSignal?.removeEventListener("abort", entry.onRevoke);
    }
    return entry;
  };
  const expire = (token: string) => {
    const entry = remove(token);
    if (entry) {
      opts.onExpire?.(entry.payload, token);
    }
  };
  return {
    mint(payload, options = {}) {
      const token = crypto.randomBytes(24).toString("hex");
      const ttlMs = options.ttlMs ?? opts.ttlMs;
      const expiresAtMs = (options.nowMs ?? now()) + ttlMs;
      const timer = setTimeout(() => expire(token), ttlMs);
      timer.unref?.();
      const { revokeSignal } = options;
      const onRevoke = () => {
        remove(token);
      };
      entries.set(token, { payload, expiresAtMs, timer, revokeSignal, onRevoke });
      revokeSignal?.addEventListener("abort", onRevoke, { once: true });
      if (revokeSignal?.aborted) {
        remove(token);
      }
      return { token, expiresAtMs };
    },
    consume(token, nowMs, accept) {
      const currentTimeMs = nowMs ?? now();
      const normalized = token.trim();
      if (!/^[a-f0-9]{48}$/u.test(normalized)) {
        return undefined;
      }
      if (accept) {
        const pending = entries.get(normalized);
        if (
          pending &&
          pending.expiresAtMs > currentTimeMs &&
          (!accept(pending.payload) || entries.get(normalized) !== pending)
        ) {
          return undefined;
        }
      }
      const entry = remove(normalized);
      if (entry && entry.expiresAtMs <= currentTimeMs) {
        opts.onExpire?.(entry.payload, normalized);
        return undefined;
      }
      return entry?.payload;
    },
    delete(token) {
      return remove(token) !== undefined;
    },
    clear() {
      for (const token of entries.keys()) {
        expire(token);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
