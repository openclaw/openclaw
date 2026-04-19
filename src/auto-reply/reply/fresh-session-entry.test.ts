/**
 * Bug 3+4 v3 regression coverage: `readLatestSessionEntryFresh` must
 * bypass any closure/cache view of a SessionEntry and read the latest
 * persisted state on every call.
 *
 * The class of bug this guards against: a closure over `let
 * activeSessionEntry` (in `agent-runner.ts:921`) that doesn't refresh
 * mid-turn went stale when `sessions.patch` wrote planMode → "normal"
 * after UI approval, leading the mutation gate to keep blocking even
 * after approval. See `fresh-session-entry.ts` for the full story.
 *
 * If any of these tests start failing, the closure-stale-ref bug is
 * back — do NOT silence the test, find the regression in
 * `loadSessionStore`'s skipCache contract or in the helper itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { readLatestSessionEntryFresh } from "./fresh-session-entry.js";

describe("readLatestSessionEntryFresh — Bug 3+4 v3 closure bypass", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fresh-session-entry-"));
    storePath = join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStore(entries: Record<string, SessionEntry>): void {
    writeFileSync(storePath, JSON.stringify(entries, null, 2));
  }

  type PlanMode = NonNullable<SessionEntry["planMode"]>;
  function planMode(mode: "plan" | "normal", overrides: Partial<PlanMode> = {}): PlanMode {
    return {
      mode,
      approval: "none",
      rejectionCount: 0,
      ...overrides,
    } as PlanMode;
  }
  function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "session-1",
      agentId: "agent-1",
      updatedAt: 1_000,
      ...overrides,
    } as SessionEntry;
  }

  it("returns LIVE entry when disk has fresher state than the stale fallback", () => {
    // The exact bug scenario: closure captured `planMode.mode = "plan"`
    // at run-start; sessions.patch wrote `planMode.mode = "normal"`
    // mid-turn after user approval.
    const staleFallback = makeEntry({ planMode: planMode("plan") });
    const liveEntry = makeEntry({ planMode: planMode("normal") });
    writeStore({ "test-key": liveEntry });

    const result = readLatestSessionEntryFresh({
      storePath,
      sessionKey: "test-key",
      fallbackEntry: staleFallback,
    });

    expect(result?.planMode?.mode).toBe("normal");
  });

  it("returns LIVE entry when disk has recentlyApprovedAt that the stale fallback lacks", () => {
    // Same shape of bug, different field: the yield-after-approval
    // grace window check at `incomplete-turn.ts:889` reads
    // recentlyApprovedAt and would miss the window if the closure
    // returned undefined for a key the disk has set.
    const staleFallback = makeEntry({ recentlyApprovedAt: undefined });
    const approvedAt = Date.now();
    const liveEntry = makeEntry({ recentlyApprovedAt: approvedAt });
    writeStore({ "test-key": liveEntry });

    const result = readLatestSessionEntryFresh({
      storePath,
      sessionKey: "test-key",
      fallbackEntry: staleFallback,
    });

    expect(result?.recentlyApprovedAt).toBe(approvedAt);
  });

  it("returns LIVE entry when disk has pendingAgentInjection that the stale fallback lacks", () => {
    // Single-source-of-truth wiring (PR-15): sessions.patch writes
    // `[QUESTION_ANSWER]: ...` / `[PLAN_DECISION]: ...` into the
    // SessionEntry; the closure capture would miss it unless the
    // helper reads fresh.
    const staleFallback = makeEntry({ pendingAgentInjection: undefined });
    const liveEntry = makeEntry({ pendingAgentInjection: "[PLAN_DECISION]: approved" });
    writeStore({ "test-key": liveEntry });

    const result = readLatestSessionEntryFresh({
      storePath,
      sessionKey: "test-key",
      fallbackEntry: staleFallback,
    });

    expect(result?.pendingAgentInjection).toBe("[PLAN_DECISION]: approved");
  });

  it("falls back to the closure entry when storePath is missing (test/in-memory path)", () => {
    const fallback = makeEntry({ planMode: planMode("plan") });
    const result = readLatestSessionEntryFresh({
      sessionKey: "test-key",
      fallbackEntry: fallback,
    });
    expect(result).toBe(fallback);
  });

  it("falls back to the closure entry when sessionKey is missing", () => {
    const fallback = makeEntry({ planMode: planMode("plan") });
    const result = readLatestSessionEntryFresh({
      storePath,
      fallbackEntry: fallback,
    });
    expect(result).toBe(fallback);
  });

  it("falls back to the closure entry when the store has no entry for the key", () => {
    writeStore({ "other-key": makeEntry({ planMode: planMode("normal") }) });
    const fallback = makeEntry({ planMode: planMode("plan") });
    const result = readLatestSessionEntryFresh({
      storePath,
      sessionKey: "missing-key",
      fallbackEntry: fallback,
    });
    expect(result).toBe(fallback);
  });

  it("falls back to the closure entry when loadSessionStore throws (corrupt JSON)", () => {
    // Corrupt the store file to force a parse error inside loadSessionStore.
    writeFileSync(storePath, "{ this is not valid json");
    const fallback = makeEntry({ planMode: planMode("plan") });
    const result = readLatestSessionEntryFresh({
      storePath,
      sessionKey: "test-key",
      fallbackEntry: fallback,
    });
    expect(result).toBe(fallback);
  });

  it("returns undefined when no fallback is provided and the store has no entry", () => {
    writeStore({});
    const result = readLatestSessionEntryFresh({
      storePath,
      sessionKey: "test-key",
    });
    expect(result).toBeUndefined();
  });

  it("never returns LESS info than the fallback would (pure superset semantic)", () => {
    // If disk lookup fails for any reason, the helper must not
    // accidentally drop the fallback. This guards the "pure superset"
    // claim in the helper's docstring.
    const fallback = makeEntry({
      planMode: planMode("plan", { approval: "pending" }),
      recentlyApprovedAt: 12345,
      pendingAgentInjection: "[QUESTION_ANSWER]: yes",
    });
    // No store file at all → load throws ENOENT.
    const result = readLatestSessionEntryFresh({
      storePath: join(tmpDir, "does-not-exist.json"),
      sessionKey: "test-key",
      fallbackEntry: fallback,
    });
    expect(result).toBe(fallback);
    expect(result?.planMode?.mode).toBe("plan");
    expect(result?.recentlyApprovedAt).toBe(12345);
    expect(result?.pendingAgentInjection).toBe("[QUESTION_ANSWER]: yes");
  });
});
