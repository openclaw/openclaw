import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../../infra/json-files.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

/**
 * Trap-test for the negative store-merge guard for `updatedAt` churn during
 * continuation persist.
 *
 * The production path lives in `src/auto-reply/reply/agent-runner.ts`
 * (`persistContinuationChainState`). It writes continuation-chain fields via
 * `updateSessionStore(...)` using a raw object spread:
 *
 *   store[key] = {
 *     ...existing,
 *     continuationChainCount,
 *     continuationChainStartedAt,
 *     continuationChainTokens,
 *     continuationChainId,
 *   };
 *
 * Two load-bearing invariants must hold:
 *
 *   (A) `updatedAt` MUST NOT appear in that spread. The chain fields are not
 *       activity events; bumping `updatedAt` here would churn idle-reset
 *       evaluation (#49515) and disk-budget pruning ordering off the actual
 *       turn timeline.
 *   (B) `saveSessionStoreUnlocked` MUST short-circuit the disk write when the
 *       serialized payload is byte-identical (the `getSerializedSessionStore`
 *       guard at store.ts:358). Without it, every `updateSessionStore` call
 *       with no real mutation would still hit `writeTextAtomic`, defeating
 *       (A) at the mtime layer and producing spurious continuation-persist
 *       activity in maintenance.
 *
 * Sabotage walks (paste either into `persistContinuationChainState`'s spread
 * to fail this trap):
 *   - Add `updatedAt: Date.now(),` to the spread → "preserves updatedAt …"
 *     case fails.
 *   - Delete the `getSerializedSessionStore(storePath) === json` early
 *     return in store.ts → "skips disk write …" case fails.
 */

const SESSION_KEY = "agent:main:discord:channel:trap-443";
// Recent enough that session-store maintenance won't prune the entry between
// updateSessionStore calls (pruning evaluates `updatedAt` against the
// configured retention window). Using `Date.now() - 60s` is comfortably
// inside any sane prune window.
const SEEDED_UPDATED_AT = Date.now() - 60_000;

type ContinuationChainPatch = {
  continuationChainCount: number;
  continuationChainStartedAt: number;
  continuationChainTokens: number;
  continuationChainId: string;
};

/**
 * Mirror of `persistContinuationChainState`'s on-disk spread (agent-runner.ts).
 * Kept inline so this test pins the exact byte-shape of the production path
 * without importing the entire agent-runner surface.
 */
async function persistChainSpread(
  storePath: string,
  sessionKey: string,
  patch: ContinuationChainPatch,
): Promise<void> {
  await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      if (resolved.existing) {
        store[resolved.normalizedKey] = {
          ...resolved.existing,
          continuationChainCount: patch.continuationChainCount,
          continuationChainStartedAt: patch.continuationChainStartedAt,
          continuationChainTokens: patch.continuationChainTokens,
          continuationChainId: patch.continuationChainId,
        };
        for (const legacyKey of resolved.legacyKeys) {
          delete store[legacyKey];
        }
      }
    },
    // Isolate the trap from background maintenance so we are asserting on
    // the persist-spread byte-shape, not on prune-side effects.
    { skipMaintenance: true },
  );
}

describe("session store: continuation chain persist updatedAt churn guard", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-store-cont-merge-",
  });
  let tempDir = "";
  let storePath = "";

  const seededChain: ContinuationChainPatch = {
    continuationChainCount: 3,
    continuationChainStartedAt: 1_699_999_000_000,
    continuationChainTokens: 12_345,
    continuationChainId: "0192abcd-7777-7000-8000-000000000001",
  };

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    clearSessionStoreCacheForTest();
    tempDir = await suiteRootTracker.make("case");
    storePath = path.join(tempDir, "sessions.json");
    const seededEntry: SessionEntry = {
      sessionId: "sess-trap-443",
      updatedAt: SEEDED_UPDATED_AT,
      ...seededChain,
    };
    await fs.writeFile(storePath, JSON.stringify({ [SESSION_KEY]: seededEntry }, null, 2), "utf-8");
    // Prime the in-process serialized cache so the byte-identity short-circuit
    // in saveSessionStoreUnlocked has a baseline to compare against. Without
    // this, the first updateSessionStore call would always write at least
    // once (cache empty → mismatch).
    loadSessionStore(storePath, { skipCache: true });
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("does not churn updatedAt when continuation chain fields are unchanged", async () => {
    const before = loadSessionStore(storePath, { skipCache: true });
    expect(before[SESSION_KEY]?.updatedAt).toBe(SEEDED_UPDATED_AT);

    // Re-persist the SAME chain values via the production spread shape.
    await persistChainSpread(storePath, SESSION_KEY, seededChain);

    const after = loadSessionStore(storePath, { skipCache: true });
    expect(
      after[SESSION_KEY]?.updatedAt,
      "updatedAt must not change when continuation-chain fields are byte-identical " +
        "(persistContinuationChainState must not include updatedAt in its spread)",
    ).toBe(SEEDED_UPDATED_AT);

    // All chain fields must still equal the seeded values.
    expect(after[SESSION_KEY]?.continuationChainCount).toBe(seededChain.continuationChainCount);
    expect(after[SESSION_KEY]?.continuationChainStartedAt).toBe(
      seededChain.continuationChainStartedAt,
    );
    expect(after[SESSION_KEY]?.continuationChainTokens).toBe(seededChain.continuationChainTokens);
    expect(after[SESSION_KEY]?.continuationChainId).toBe(seededChain.continuationChainId);
  });

  it("skips disk write entirely when the serialized payload is unchanged", async () => {
    // Re-load to populate the serialized-store cache so the byte-identity
    // short-circuit in saveSessionStoreUnlocked has a baseline to compare.
    loadSessionStore(storePath, { skipCache: true });

    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");
    try {
      await persistChainSpread(storePath, SESSION_KEY, seededChain);
      expect(
        writeSpy,
        "no-op continuation-chain persist must not hit writeTextAtomic " +
          "(getSerializedSessionStore short-circuit at store.ts:~358)",
      ).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("changes only the mutated chain field and still preserves updatedAt", async () => {
    // Mutate ONLY tokens (e.g. continuation step accumulated more usage).
    const mutated: ContinuationChainPatch = {
      ...seededChain,
      continuationChainTokens: seededChain.continuationChainTokens + 7_777,
    };

    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");
    try {
      await persistChainSpread(storePath, SESSION_KEY, mutated);
      expect(
        writeSpy,
        "real chain mutation must reach disk (sanity counterpart to the " +
          "no-op short-circuit assertion above)",
      ).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
    }

    const after = loadSessionStore(storePath, { skipCache: true });
    expect(
      after[SESSION_KEY]?.updatedAt,
      "updatedAt must be preserved even when chain tokens change — " +
        "the spread in persistContinuationChainState carries chain fields only",
    ).toBe(SEEDED_UPDATED_AT);
    expect(after[SESSION_KEY]?.continuationChainTokens).toBe(mutated.continuationChainTokens);
  });
});
