import { describe, expect, it } from "vitest";
import { resolveReplyInitConflictAction } from "./reply-session-init-conflict.js";

describe("resolveReplyInitConflictAction", () => {
  it("retries with a fresh snapshot on the first conflict", () => {
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: false,
        selfHealRequested: false,
        conflictRecoveryAttempted: false,
      }),
    ).toEqual({ kind: "stale-snapshot-retry" });
  });

  it("defers to the unlocked jittered backoff while its retries are not exhausted", () => {
    // While runWithSessionInitConflictRetry still owns the retry budget the
    // conflict must surface as the typed error (conflict-backoff), never as a
    // teardown: transient CAS races settle without side effects (#102400).
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: true,
        selfHealRequested: false,
        conflictRecoveryAttempted: false,
      }),
    ).toEqual({ kind: "conflict-backoff" });
  });

  it("self-heals instead of throwing once the backoff retries are exhausted", () => {
    // Regression guard: previously this state threw immediately, wedging the
    // session for ANY runtime (native Anthropic and Codex alike) so it silently
    // returned empty tool-results. Once the backoff pass is exhausted it must
    // trigger the harness self-heal + retry so init can complete instead of
    // throwing (#101909).
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: true,
        selfHealRequested: true,
        conflictRecoveryAttempted: false,
      }),
    ).toEqual({ kind: "self-heal-retry" });
  });

  it("only self-heals once, then fails clearly", () => {
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: true,
        selfHealRequested: true,
        conflictRecoveryAttempted: true,
      }),
    ).toEqual({ kind: "fail" });
  });

  it("prefers the stale-snapshot retry even after recovery ran", () => {
    // A fresh init attempt after recovery starts with staleSnapshotRetried=false,
    // so it should take one more benign snapshot retry before failing.
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: false,
        selfHealRequested: true,
        conflictRecoveryAttempted: true,
      }),
    ).toEqual({ kind: "stale-snapshot-retry" });
  });
});
