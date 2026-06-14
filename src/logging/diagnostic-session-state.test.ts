// Regression: pruneDiagnosticSessionStates must clean up non-idle stale entries
// so ghost entries do not accumulate indefinitely after failed recovery attempts.
// See https://github.com/openclaw/openclaw/issues/91697
import { describe, expect, it } from "vitest";
import {
  diagnosticSessionStates,
  pruneDiagnosticSessionStates,
  type SessionState,
} from "./diagnostic-session-state.js";

const SESSION_STATE_TTL_MS = 30 * 60 * 1000; // 30 min

function setEntry(key: string, state: Partial<SessionState> & { lastActivity: number }) {
  diagnosticSessionStates.set(key, {
    state: "idle",
    queueDepth: 0,
    ...state,
  });
}

describe("pruneDiagnosticSessionStates", () => {
  it("removes idle entries older than TTL", () => {
    diagnosticSessionStates.clear();
    const now = Date.now();
    setEntry("idle-old", { state: "idle", queueDepth: 0, lastActivity: now - SESSION_STATE_TTL_MS - 1 });
    setEntry("idle-recent", { state: "idle", queueDepth: 0, lastActivity: now });

    pruneDiagnosticSessionStates(now, true);

    expect(diagnosticSessionStates.has("idle-old")).toBe(false);
    expect(diagnosticSessionStates.has("idle-recent")).toBe(true);
  });

  it("removes non-idle stale entries older than TTL (regression #91697)", () => {
    diagnosticSessionStates.clear();
    const now = Date.now();

    // Simulate a ghost entry: state stuck at "processing" after failed recovery.
    setEntry("ghost-processing", {
      state: "processing",
      queueDepth: 0,
      lastActivity: now - SESSION_STATE_TTL_MS - 1,
    });

    // Simulate a ghost entry: state stuck at "waiting" after failed recovery.
    setEntry("ghost-waiting", {
      state: "waiting",
      queueDepth: 0,
      lastActivity: now - SESSION_STATE_TTL_MS - 1,
    });

    // A recent non-idle entry should NOT be pruned.
    setEntry("recent-processing", {
      state: "processing",
      queueDepth: 0,
      lastActivity: now,
    });

    pruneDiagnosticSessionStates(now, true);

    expect(diagnosticSessionStates.has("ghost-processing")).toBe(false);
    expect(diagnosticSessionStates.has("ghost-waiting")).toBe(false);
    expect(diagnosticSessionStates.has("recent-processing")).toBe(true);
  });

  it("does not remove non-idle entries within TTL", () => {
    diagnosticSessionStates.clear();
    const now = Date.now();

    setEntry("active-processing", {
      state: "processing",
      queueDepth: 1,
      lastActivity: now - SESSION_STATE_TTL_MS + 1000,
    });

    pruneDiagnosticSessionStates(now, true);

    expect(diagnosticSessionStates.has("active-processing")).toBe(true);
  });
});
