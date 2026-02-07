import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompactionCheckpoint, ExperientialMoment, SessionSummary } from "./types.js";
import { ExperientialStore } from "./store.js";

function makeMoment(overrides: Partial<ExperientialMoment> = {}): ExperientialMoment {
  return {
    id: `moment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    timestamp: Date.now(),
    sessionKey: "agent:main:main",
    source: "message",
    content: "test moment content",
    significance: {
      total: 0.5,
      emotional: 0.3,
      uncertainty: 0.2,
      relationship: 0.4,
      consequential: 0.6,
      reconstitution: 0.5,
    },
    disposition: "buffered",
    reasons: ["test reason"],
    anchors: ["test anchor"],
    uncertainties: ["test uncertainty"],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    sessionKey: "agent:main:main",
    startedAt: Date.now() - 3600000,
    endedAt: Date.now(),
    topics: ["topic-a", "topic-b"],
    momentCount: 5,
    keyAnchors: ["anchor-1"],
    openUncertainties: ["uncertainty-1"],
    reconstitutionHints: ["hint-1"],
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<CompactionCheckpoint> = {}): CompactionCheckpoint {
  return {
    id: `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    timestamp: Date.now(),
    sessionKey: "agent:main:main",
    trigger: "auto",
    activeTopics: ["topic-x"],
    keyContextSummary: "test context summary",
    openUncertainties: ["open-q"],
    conversationAnchors: ["anchor-conv"],
    ...overrides,
  };
}

describe("ExperientialStore", () => {
  let dbPath: string;
  let store: ExperientialStore;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "experiential-test-"));
    dbPath = path.join(tmpDir, "test.db");
    store = new ExperientialStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  describe("moments", () => {
    it("saves and retrieves a moment by session", () => {
      const moment = makeMoment();
      store.saveMoment(moment);

      const results = store.getMomentsBySession(moment.sessionKey);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(moment.id);
      expect(results[0].content).toBe(moment.content);
      expect(results[0].significance.total).toBe(0.5);
      expect(results[0].anchors).toEqual(["test anchor"]);
    });

    it("retrieves recent moments with minimum significance", () => {
      store.saveMoment(
        makeMoment({
          id: "low",
          significance: {
            total: 0.2,
            emotional: 0,
            uncertainty: 0,
            relationship: 0,
            consequential: 0,
            reconstitution: 0,
          },
        }),
      );
      store.saveMoment(
        makeMoment({
          id: "high",
          significance: {
            total: 0.9,
            emotional: 0,
            uncertainty: 0,
            relationship: 0,
            consequential: 0,
            reconstitution: 0,
          },
        }),
      );
      store.saveMoment(
        makeMoment({
          id: "mid",
          significance: {
            total: 0.6,
            emotional: 0,
            uncertainty: 0,
            relationship: 0,
            consequential: 0,
            reconstitution: 0,
          },
        }),
      );

      const results = store.getRecentMoments(10, 0.5);
      expect(results).toHaveLength(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain("high");
      expect(ids).toContain("mid");
    });

    it("retrieves buffered moments for a session", () => {
      const sessionKey = "agent:test:test";
      store.saveMoment(makeMoment({ id: "buf1", sessionKey, disposition: "buffered" }));
      store.saveMoment(makeMoment({ id: "imm1", sessionKey, disposition: "immediate" }));
      store.saveMoment(makeMoment({ id: "buf2", sessionKey, disposition: "buffered" }));

      const results = store.getBufferedMoments(sessionKey);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id)).toEqual(["buf1", "buf2"]);
    });

    it("handles optional fields correctly", () => {
      const moment = makeMoment({ toolName: "read_file", emotionalSignature: "curious" });
      store.saveMoment(moment);

      const results = store.getMomentsBySession(moment.sessionKey);
      expect(results[0].toolName).toBe("read_file");
      expect(results[0].emotionalSignature).toBe("curious");
    });

    it("handles missing optional fields", () => {
      const moment = makeMoment();
      delete (moment as Record<string, unknown>).toolName;
      delete (moment as Record<string, unknown>).emotionalSignature;
      store.saveMoment(moment);

      const results = store.getMomentsBySession(moment.sessionKey);
      expect(results[0].toolName).toBeUndefined();
      expect(results[0].emotionalSignature).toBeUndefined();
    });

    it("archives buffered moments and excludes them from subsequent queries", () => {
      const sessionKey = "agent:archive:test";
      store.saveMoment(makeMoment({ id: "b1", sessionKey, disposition: "buffered" }));
      store.saveMoment(makeMoment({ id: "b2", sessionKey, disposition: "buffered" }));
      store.saveMoment(makeMoment({ id: "i1", sessionKey, disposition: "immediate" }));

      expect(store.getBufferedMoments(sessionKey)).toHaveLength(2);

      const archived = store.archiveBufferedMoments(sessionKey);
      expect(archived).toBe(2);

      // Buffered query now returns nothing
      expect(store.getBufferedMoments(sessionKey)).toHaveLength(0);

      // All moments still exist (now 2 archived + 1 immediate)
      expect(store.getMomentsBySession(sessionKey)).toHaveLength(3);
    });

    it("archiveBufferedMoments does not affect other session keys", () => {
      store.saveMoment(makeMoment({ id: "a1", sessionKey: "agent:a:a", disposition: "buffered" }));
      store.saveMoment(makeMoment({ id: "b1", sessionKey: "agent:b:b", disposition: "buffered" }));

      store.archiveBufferedMoments("agent:a:a");

      expect(store.getBufferedMoments("agent:a:a")).toHaveLength(0);
      expect(store.getBufferedMoments("agent:b:b")).toHaveLength(1);
    });
  });

  describe("session summaries", () => {
    it("saves and retrieves a session summary", () => {
      const summary = makeSummary();
      store.saveSessionSummary(summary);

      const results = store.getRecentSummaries(10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(summary.id);
      expect(results[0].topics).toEqual(["topic-a", "topic-b"]);
      expect(results[0].reconstitutionHints).toEqual(["hint-1"]);
    });

    it("retrieves summary by session key", () => {
      const summary = makeSummary({ sessionKey: "agent:special:session" });
      store.saveSessionSummary(summary);

      const result = store.getSessionSummary("agent:special:session");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(summary.id);
    });

    it("returns null for missing session summary", () => {
      const result = store.getSessionSummary("nonexistent");
      expect(result).toBeNull();
    });

    it("orders recent summaries by ended_at descending", () => {
      const now = Date.now();
      store.saveSessionSummary(makeSummary({ id: "old", endedAt: now - 2000 }));
      store.saveSessionSummary(makeSummary({ id: "new", endedAt: now }));
      store.saveSessionSummary(makeSummary({ id: "mid", endedAt: now - 1000 }));

      const results = store.getRecentSummaries(10);
      expect(results.map((r) => r.id)).toEqual(["new", "mid", "old"]);
    });
  });

  describe("compaction checkpoints", () => {
    it("saves and retrieves the latest checkpoint", () => {
      const checkpoint = makeCheckpoint();
      store.saveCheckpoint(checkpoint);

      const result = store.getLatestCheckpoint();
      expect(result).not.toBeNull();
      expect(result!.id).toBe(checkpoint.id);
      expect(result!.keyContextSummary).toBe("test context summary");
      expect(result!.activeTopics).toEqual(["topic-x"]);
    });

    it("returns null when no checkpoints exist", () => {
      const result = store.getLatestCheckpoint();
      expect(result).toBeNull();
    });

    it("retrieves recent checkpoints in order", () => {
      const now = Date.now();
      store.saveCheckpoint(makeCheckpoint({ id: "cp1", timestamp: now - 2000 }));
      store.saveCheckpoint(makeCheckpoint({ id: "cp2", timestamp: now }));
      store.saveCheckpoint(makeCheckpoint({ id: "cp3", timestamp: now - 1000 }));

      const results = store.getRecentCheckpoints(2);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("cp2");
      expect(results[1].id).toBe("cp3");
    });
  });

  describe("schema idempotency", () => {
    it("can open the same DB file twice without error", () => {
      store.close();
      // Re-open the same DB -- schema should be applied idempotently
      const store2 = new ExperientialStore(dbPath);
      store2.saveMoment(makeMoment());
      expect(store2.getRecentMoments(1)).toHaveLength(1);
      store2.close();
    });
  });
});
