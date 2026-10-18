// Active-session shutdown tracker tests protect the in-memory drain list used
// when gateway shutdown, restart, or lifecycle cleanup must emit one session_end.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";

// Keep deduplication and snapshot ownership pinned alongside the shutdown drain tests.
const session = {
  cfg: {},
  sessionKey: "agent:main:main",
  sessionId: "session-A",
  storePath: "/tmp/store.json",
  agentId: "main",
};

afterEach(() => {
  for (const entry of listActiveSessionsForShutdown()) {
    forgetActiveSessionForShutdown(entry.sessionId);
  }
});

describe("active-sessions-shutdown-tracker", () => {
  it("notes sessions keyed by sessionId so re-noting the same id replaces the entry", () => {
    noteActiveSessionForShutdown({ ...session, sessionFile: "/tmp/old.jsonl" });
    noteActiveSessionForShutdown({ ...session, sessionFile: "/tmp/new.jsonl" });

    const entries = listActiveSessionsForShutdown();
    expect(entries).toHaveLength(1);
    expect(expectDefined(entries[0], "entries[0] test invariant").sessionId).toBe("session-A");
    expect(expectDefined(entries[0], "entries[0] test invariant").sessionFile).toBe(
      "/tmp/new.jsonl",
    );
  });

  it("ignores empty sessionId notes", () => {
    noteActiveSessionForShutdown({ ...session, sessionId: "" });

    expect(listActiveSessionsForShutdown()).toEqual([]);
  });

  it("treats forget on an unknown sessionId as a no-op", () => {
    noteActiveSessionForShutdown(session);

    forgetActiveSessionForShutdown("does-not-exist");
    forgetActiveSessionForShutdown(undefined);

    expect(listActiveSessionsForShutdown()).toHaveLength(1);
  });

  it("returns a snapshot list so callers do not mutate the underlying tracker", () => {
    noteActiveSessionForShutdown(session);

    const snapshot = listActiveSessionsForShutdown();
    snapshot.length = 0;

    expect(listActiveSessionsForShutdown()).toHaveLength(1);
  });
});
