/**
 * File-backed token store for ConsentGate durable storage.
 * Uses atomic write (tmp + rename). Single process only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConsentToken, ConsentTokenStatus } from "./types.js";
import type { TokenStore } from "./store.js";
import { ALLOWED_TRANSITIONS } from "./store.js";

const TOKENS_FILE = "tokens.json";
const TOKENS_TMP = "tokens.json.tmp";

/**
 * Create a token store that persists to a directory.
 * Tokens are stored in storagePath/tokens.json; state survives process restart.
 */
export function createFileBackedTokenStore(storagePath: string): TokenStore {
  const tokensPath = path.join(storagePath, TOKENS_FILE);
  const tmpPath = path.join(storagePath, TOKENS_TMP);
  const map = new Map<string, ConsentToken>();
  let loaded = false;

  function load(): void {
    if (loaded) return;
    loaded = true;
    if (!existsSync(tokensPath)) return;
    try {
      const raw = readFileSync(tokensPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, ConsentToken>;
      for (const [jti, t] of Object.entries(data)) {
        map.set(jti, t);
      }
    } catch {
      // Corrupt or missing; start empty.
    }
  }

  function persist(): void {
    mkdirSync(storagePath, { recursive: true });
    const data: Record<string, ConsentToken> = {};
    for (const [jti, t] of map.entries()) {
      data[jti] = t;
    }
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, tokensPath);
  }

  const allowed = ALLOWED_TRANSITIONS;

  return {
    put(token) {
      load();
      map.set(token.jti, { ...token });
      persist();
    },
    get(jti) {
      load();
      return map.get(jti);
    },
    transition(jti, toStatus) {
      load();
      const token = map.get(jti);
      if (!token) return false;
      const allowedList = allowed[token.status];
      if (!allowedList?.includes(toStatus)) return false;
      token.status = toStatus;
      persist();
      return true;
    },
    findBySession(sessionKey, tenantId) {
      load();
      const out: ConsentToken[] = [];
      for (const t of map.values()) {
        if (t.sessionKey !== sessionKey) continue;
        if (tenantId != null && (t as Record<string, unknown>).tenantId !== tenantId) continue;
        out.push(t);
      }
      return out;
    },
    list(tenantId) {
      load();
      const out: ConsentToken[] = [];
      for (const t of map.values()) {
        if (tenantId != null && (t as Record<string, unknown>).tenantId !== tenantId) continue;
        out.push(t);
      }
      return out;
    },
    pruneExpired(nowMs) {
      load();
      let n = 0;
      for (const [jti, t] of map.entries()) {
        if (t.expiresAt < nowMs && t.status === "issued") {
          t.status = "expired";
          n++;
        }
      }
      if (n > 0) persist();
      return n;
    },
  };
}
