import { describe, expect, it } from "vitest";
import {
  classifyCronJobStagnation,
  isSpecificCronErrorReason,
  normalizeCronFailureSignatureCause,
} from "./stagnation.js";

describe("normalizeCronFailureSignatureCause", () => {
  it("normalizes volatile timestamps, UUIDs, process ids, and elapsed durations into one cause", () => {
    const first = normalizeCronFailureSignatureCause({
      error:
        "2026-11-25T10:00:00Z sync helper (pid=4120, cid=18, req=550e8400-e29b-41d4-a716-446655440000) failed after 12.4s",
    });
    const second = normalizeCronFailureSignatureCause({
      error:
        "2026-11-25 11:05:19.250+00:00 sync helper (pid=9811, cid=99, req=6ba7b810-9dad-11d1-80b4-00c04fd430c8) failed after 3.1s",
    });

    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it("keeps distinct configured endpoints, status codes, and error messages distinct", () => {
    const ollamaDefault = normalizeCronFailureSignatureCause({
      error: "Local provider unavailable at http://127.0.0.1:11434",
    });
    const customPort = normalizeCronFailureSignatureCause({
      error: "Local provider unavailable at http://127.0.0.1:1234",
    });
    const auth401 = normalizeCronFailureSignatureCause({
      error: "Webhook returned HTTP 401",
    });
    const forbidden403 = normalizeCronFailureSignatureCause({
      error: "Webhook returned HTTP 403",
    });

    expect(ollamaDefault).not.toBe(customPort);
    expect(auth401).not.toBe(forbidden403);
  });

  it("falls through generic unknown errorReason to detail or normalized error text", () => {
    expect(isSpecificCronErrorReason("timeout")).toBe(true);
    expect(isSpecificCronErrorReason("unknown")).toBe(false);
    expect(isSpecificCronErrorReason("unclassified")).toBe(false);
    expect(isSpecificCronErrorReason("no_error_details")).toBe(false);

    const missingFile = normalizeCronFailureSignatureCause({
      errorReason: "unknown",
      error: "ENOENT: missing helper input A",
    });
    const syntaxBug = normalizeCronFailureSignatureCause({
      errorReason: "unknown",
      error: "SyntaxError: unexpected token in helper B",
    });
    const stallDetail = normalizeCronFailureSignatureCause({
      errorReason: "unknown",
      failureNotificationDetail: { kind: "agent-stall", classification: "blocked_tool_call" },
      error: "changing prose 1",
    });

    expect(missingFile).not.toBe(syntaxBug);
    expect(stallDetail).toEqual({ kind: "agent-stall", classification: "blocked_tool_call" });
  });
});

describe("classifyCronJobStagnation", () => {
  it("treats high-volume ok and no_change runs as healthy, never stagnant", () => {
    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "ok",
        outcome: "no_change",
        consecutiveErrors: 0,
        recentOkRuns: 48,
      }),
    ).toEqual({ kind: "healthy" });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "skipped",
        consecutiveErrors: 0,
      }),
    ).toEqual({ kind: "healthy" });
  });

  it("preserves intentional pauses, cancellations, and healthy in-flight or retry waits", () => {
    expect(
      classifyCronJobStagnation({
        enabled: false,
        status: "error",
        consecutiveErrors: 5,
        sameSignature: true,
        error: "helper failed",
      }),
    ).toEqual({ kind: "paused" });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        aborted: true,
        consecutiveErrors: 4,
        sameSignature: true,
        error: "cancelled",
      }),
    ).toEqual({ kind: "paused" });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        pendingTransientRetry: true,
        consecutiveErrors: 3,
        sameSignature: true,
        errorReason: "server_error",
      }),
    ).toEqual({ kind: "healthy_wait" });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "ok",
        runningAtMs: 1_000,
        consecutiveErrors: 0,
      }),
    ).toEqual({ kind: "healthy_wait" });
  });

  it("classifies blank or unattributed errors as unknown_outcome rather than stagnation", () => {
    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        consecutiveErrors: 5,
        sameSignature: true,
        errorReason: "unknown",
        error: "   ",
      }),
    ).toEqual({ kind: "unknown_outcome" });
  });

  it("distinguishes repeated general stagnation from permission and auth boundaries", () => {
    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        consecutiveErrors: 3,
        sameSignature: true,
        error: "ENOENT: no such file or directory, open 'report-input.csv'",
      }),
    ).toEqual({
      kind: "repeated_failure_stagnation",
      streak: 3,
      disposition: "explore_new_approach",
    });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        consecutiveErrors: 4,
        sameSignature: true,
        error: "Permission denied: tool exec is not allowed by toolsAllow policy",
      }),
    ).toEqual({
      kind: "repeated_failure_stagnation",
      streak: 4,
      disposition: "authority_or_auth_gate",
    });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        consecutiveErrors: 3,
        sameSignature: true,
        errorReason: "auth_permanent",
        error: "OAuth token revoked",
      }),
    ).toEqual({
      kind: "repeated_failure_stagnation",
      streak: 3,
      disposition: "authority_or_auth_gate",
    });
  });

  it("does not flag changed error signatures or sub-threshold streaks as stagnation", () => {
    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        consecutiveErrors: 4,
        sameSignature: false,
        error: "different failure cause",
      }),
    ).toEqual({
      kind: "distinct_or_early_failure",
      boundary: "general",
    });

    expect(
      classifyCronJobStagnation({
        enabled: true,
        status: "error",
        consecutiveErrors: 2,
        sameSignature: true,
        error: "Permission denied: missing calendar scope",
      }),
    ).toEqual({
      kind: "distinct_or_early_failure",
      boundary: "authority_or_auth",
    });
  });
});
