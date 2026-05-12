import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearActiveSessionsForShutdownTracker,
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";

// Regression coverage for #57790: the in-memory active-session tracker that
// the close handler drains on shutdown / restart must be keyed by sessionId,
// must not double-track the same session, and must forget sessions that have
// already been finalized through replace / reset / delete / compaction so
// the shutdown drain never double-fires `session_end` for them.

const cfg: OpenClawConfig = {};

afterEach(() => {
  clearActiveSessionsForShutdownTracker();
});

describe("active-sessions-shutdown-tracker", () => {
  it("returns an empty list when no sessions have been noted", () => {
    expect(listActiveSessionsForShutdown()).toEqual([]);
  });

  it("notes sessions keyed by sessionId so re-noting the same id replaces the entry", () => {
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "session-A",
      agentId: "main",
    });
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "session-A",
      agentId: "main",
    });

    const entries = listActiveSessionsForShutdown();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe("session-A");
    expect(entries[0].agentId).toBe("main");
  });

  it("ignores empty sessionId notes", () => {
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "",
    });

    expect(listActiveSessionsForShutdown()).toEqual([]);
  });

  it("forgets a session by id so a subsequent drain does not see it", () => {
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "session-A",
    });
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:other",
      sessionId: "session-B",
    });

    forgetActiveSessionForShutdown("session-A");

    const entries = listActiveSessionsForShutdown();
    expect(entries.map((entry) => entry.sessionId)).toEqual(["session-B"]);
  });

  it("treats forget on an unknown sessionId as a no-op", () => {
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "session-A",
    });

    forgetActiveSessionForShutdown("does-not-exist");
    forgetActiveSessionForShutdown(undefined);

    expect(listActiveSessionsForShutdown()).toHaveLength(1);
  });

  it("returns a snapshot list so callers do not mutate the underlying tracker", () => {
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:main",
      sessionId: "session-A",
    });

    const snapshot = listActiveSessionsForShutdown();
    snapshot.length = 0;

    expect(listActiveSessionsForShutdown()).toHaveLength(1);
  });

  it("clears the entire tracker for test isolation", () => {
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:a",
      sessionId: "session-A",
    });
    noteActiveSessionForShutdown({
      cfg,
      sessionKey: "agent:main:b",
      sessionId: "session-B",
    });

    clearActiveSessionsForShutdownTracker();

    expect(listActiveSessionsForShutdown()).toEqual([]);
  });
});
