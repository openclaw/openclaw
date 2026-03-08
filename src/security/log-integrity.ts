/**
 * EO-004: Audit Log Integrity — HMAC-SHA256 chaining
 *
 * Provides tamper-evident log chaining: each entry includes an HMAC-SHA256
 * computed over (previousChainHash + serialized entry payload), using a
 * caller-supplied secret key.  An attacker who modifies any past log entry
 * must re-forge every subsequent HMAC, which is infeasible without the key.
 *
 * Usage:
 *   const chain = new LogIntegrityChain(secretKey);
 *   const sealed = chain.seal({ level: "info", message: "user logged in", ts: Date.now() });
 *   // store `sealed` (which includes sealed.chain for the running hash)
 *
 *   // Verify a sequence of sealed entries:
 *   const ok = LogIntegrityChain.verify(sealedEntries, secretKey);
 */

import crypto from "node:crypto";

/** Raw log entry payload before sealing. */
export type LogEntry = {
  level: string;
  message: string;
  ts: number;
  [key: string]: unknown;
};

/** A log entry with its HMAC chain hash appended. */
export type SealedLogEntry = LogEntry & {
  /** HMAC-SHA256(key, previousChain || JSON(payload)) over the immutable fields. */
  chain: string;
};

/** Genesis hash used when there is no previous entry. */
const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Stateful chain builder.  Create one instance per log stream (e.g., per file
 * or per session).  Call `seal()` in order for each entry.
 */
export class LogIntegrityChain {
  private previousHash: string;

  constructor(
    private readonly secretKey: string,
    /** Optionally seed from the last stored chain hash to resume an existing log. */
    lastChainHash?: string,
  ) {
    this.previousHash = lastChainHash ?? GENESIS_HASH;
  }

  /**
   * Seal a log entry by appending an HMAC chain hash.
   * The original `entry` object is not mutated; a new object is returned.
   */
  seal(entry: LogEntry): SealedLogEntry {
    const payload = JSON.stringify(entry);
    const hmac = crypto.createHmac("sha256", this.secretKey);
    hmac.update(this.previousHash);
    hmac.update(payload);
    const chain = hmac.digest("hex");
    this.previousHash = chain;
    return { ...entry, chain };
  }

  /** Return the current chain tip (hash of the last sealed entry). */
  get currentHash(): string {
    return this.previousHash;
  }

  /**
   * Verify the integrity of an ordered sequence of sealed entries.
   *
   * Returns `{ valid: true }` if the chain is unbroken, or
   * `{ valid: false; firstBadIndex: number; expected: string; actual: string }`
   * if any entry has been tampered with.
   */
  static verify(
    entries: SealedLogEntry[],
    secretKey: string,
    seedHash?: string,
  ):
    | { valid: true }
    | { valid: false; firstBadIndex: number; expected: string; actual: string } {
    let previousHash = seedHash ?? GENESIS_HASH;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      // Reconstruct payload without the chain field
      const { chain: storedChain, ...payload } = entry;
      const payloadStr = JSON.stringify(payload);
      const hmac = crypto.createHmac("sha256", secretKey);
      hmac.update(previousHash);
      hmac.update(payloadStr);
      const expected = hmac.digest("hex");

      if (storedChain !== expected) {
        return { valid: false, firstBadIndex: i, expected, actual: storedChain };
      }
      previousHash = expected;
    }
    return { valid: true };
  }
}
