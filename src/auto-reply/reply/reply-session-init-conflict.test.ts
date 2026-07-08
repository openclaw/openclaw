import { describe, expect, it } from "vitest";
import { resolveReplyInitConflictAction } from "./reply-session-init-conflict.js";

describe("resolveReplyInitConflictAction", () => {
  it("retries with a fresh snapshot on the first conflict", () => {
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: false,
        conflictRecoveryAttempted: false,
      }),
    ).toEqual({ kind: "stale-snapshot-retry" });
  });

  it("self-heals instead of throwing once the stale-snapshot retry is exhausted", () => {
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: true,
        conflictRecoveryAttempted: false,
      }),
    ).toEqual({ kind: "self-heal-retry" });
  });

  it("only self-heals once, then fails clearly", () => {
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: true,
        conflictRecoveryAttempted: true,
      }),
    ).toEqual({ kind: "fail" });
  });

  it("prefers the stale-snapshot retry even after recovery ran", () => {
    expect(
      resolveReplyInitConflictAction({
        staleSnapshotRetried: false,
        conflictRecoveryAttempted: true,
      }),
    ).toEqual({ kind: "stale-snapshot-retry" });
  });
});
