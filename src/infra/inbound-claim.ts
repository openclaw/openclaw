/**
 * Inbound message claim store for cross-instance deduplication.
 * When multiple gateway instances receive the same webhook (e.g. Telegram),
 * only the instance that "claims" the message processes it; others skip.
 * Uses a tryClaim(key, ttlMs) semantic: first caller gets true, others false.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CLAIM_TTL_MS = 5 * 60_000; // 5 minutes

export type InboundClaimStore = {
  /** Returns true if this instance won the claim (should process); false if another instance already claimed. */
  tryClaim(key: string, ttlMs?: number): Promise<boolean>;
};

/** In-memory store: single process only. For single-gateway or tests. */
export function createMemoryInboundClaimStore(): InboundClaimStore {
  const seen = new Map<string, number>();

  return {
    async tryClaim(key: string, ttlMs = DEFAULT_CLAIM_TTL_MS): Promise<boolean> {
      if (!key) {
        return false;
      }
      const now = Date.now();
      const existing = seen.get(key);
      if (existing !== undefined && (ttlMs <= 0 || now - existing < ttlMs)) {
        return false;
      }
      seen.set(key, now);
      // Prune old entries to avoid unbounded growth
      if (ttlMs > 0) {
        const cutoff = now - ttlMs;
        for (const [k, ts] of seen) {
          if (ts < cutoff) {
            seen.delete(k);
          }
        }
      }
      return true;
    },
  };
}

/** Safe filename from claim key: hash to avoid path traversal and length issues. */
function claimKeyToFilename(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** File-based store: shared directory (e.g. NFS) so multiple gateway processes see the same claims. */
export function createFileInboundClaimStore(opts: {
  dir: string;
  ttlMs?: number;
}): InboundClaimStore {
  const baseDir = path.resolve(opts.dir);
  const ttlMs = opts.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
  let lastPruneAt = 0;
  const PRUNE_INTERVAL_MS = 60_000; // prune at most once per minute

  const pruneIfNeeded = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    lastPruneAt = now;
    const cutoff = now - ttlMs;
    try {
      const entries = await fs.readdir(baseDir);
      await Promise.all(
        entries.map(async (name) => {
          const filePath = path.join(baseDir, name);
          try {
            const st = await fs.stat(filePath);
            if (st.mtimeMs < cutoff) {
              await fs.unlink(filePath);
            }
          } catch {
            // ignore missing or permission errors
          }
        }),
      );
    } catch {
      // ignore readdir errors (dir may not exist yet)
    }
  };

  return {
    async tryClaim(key: string, _keyTtlMs = ttlMs): Promise<boolean> {
      if (!key) {
        return false;
      }
      const filename = claimKeyToFilename(key);
      const filePath = path.join(baseDir, filename);
      const payload = JSON.stringify({ claimedAt: Date.now() });

      try {
        await fs.mkdir(baseDir, { recursive: true });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "EEXIST") {
          throw err;
        }
      }

      try {
        const handle = await fs.open(filePath, "wx");
        try {
          await handle.writeFile(payload, "utf8");
        } finally {
          await handle.close();
        }
        await pruneIfNeeded();
        return true;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "EEXIST") {
          await pruneIfNeeded();
          return false;
        }
        throw err;
      }
    },
  };
}

/**
 * Create an inbound claim store from config.
 * - "memory" or absent: in-memory (single process).
 * - { file: { dir: string } }: file-based (shared dir for multi-instance).
 */
export function createInboundClaimStoreFromConfig(config: {
  inboundDedupe?: "memory" | { file?: { dir?: string } };
}): InboundClaimStore | null {
  const raw = config.inboundDedupe;
  if (raw === undefined || raw === "memory") {
    return createMemoryInboundClaimStore();
  }
  if (typeof raw === "object" && raw?.file?.dir) {
    return createFileInboundClaimStore({ dir: raw.file.dir });
  }
  return createMemoryInboundClaimStore();
}
