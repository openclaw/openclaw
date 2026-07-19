// Agent database cache tests cover bounded process-local SQLite handle ownership.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempStateDirs: string[] = [];

function createTempStateDir(): string {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-cache-")),
  );
  tempStateDirs.push(stateDir);
  return stateDir;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const stateDir of tempStateDirs.splice(0)) {
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
});

describe("openclaw agent database handle cache", () => {
  it("keeps only the capped number of open handles", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const databases = Array.from({ length: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP + 1 }, (_, index) =>
      openOpenClawAgentDatabase({ agentId: `worker-${index}`, env }),
    );
    const leastRecentlyUsed = databases[0]!;

    expect(databases.filter((database) => database.db.isOpen)).toHaveLength(
      OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
    );
    expect(isOpenClawAgentDatabaseOpen(leastRecentlyUsed.path)).toBe(false);
    expect(leastRecentlyUsed.db.isOpen).toBe(false);
  });

  it("refreshes cache-hit recency before evicting the true LRU handle", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const recentlyUsed = openOpenClawAgentDatabase({ agentId: "recently-used", env });
    const untouched = Array.from({ length: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP - 1 }, (_, index) =>
      openOpenClawAgentDatabase({ agentId: `untouched-${index}`, env }),
    );
    const leastRecentlyUsed = untouched[0]!;

    expect(openOpenClawAgentDatabase({ agentId: "recently-used", env })).toBe(recentlyUsed);
    openOpenClawAgentDatabase({ agentId: "newest", env });

    expect(recentlyUsed.db.isOpen).toBe(true);
    expect(isOpenClawAgentDatabaseOpen(recentlyUsed.path)).toBe(true);
    expect(leastRecentlyUsed.db.isOpen).toBe(false);
    expect(isOpenClawAgentDatabaseOpen(leastRecentlyUsed.path)).toBe(false);
  });

  it("never evicts an LRU handle with an open transaction", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const transactionOwner = openOpenClawAgentDatabase({ agentId: "transaction-owner", env });
    transactionOwner.db.exec("BEGIN IMMEDIATE");
    try {
      const untouched = Array.from({ length: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP - 1 }, (_, index) =>
        openOpenClawAgentDatabase({ agentId: `untouched-${index}`, env }),
      );
      const leastRecentlyUsed = untouched[0]!;
      openOpenClawAgentDatabase({ agentId: "newest", env });

      expect(transactionOwner.db.isOpen).toBe(true);
      expect(transactionOwner.db.isTransaction).toBe(true);
      expect(isOpenClawAgentDatabaseOpen(transactionOwner.path)).toBe(true);
      expect(leastRecentlyUsed.db.isOpen).toBe(false);
      expect(isOpenClawAgentDatabaseOpen(leastRecentlyUsed.path)).toBe(false);
    } finally {
      transactionOwner.db.exec("ROLLBACK");
    }
  });

  it("reopens an evicted database without losing durable rows", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const evicted = openOpenClawAgentDatabase({ agentId: "evicted", env });
    evicted.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("cache-eviction", JSON.stringify({ preserved: true }), 42);

    for (let index = 0; index < OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP; index += 1) {
      openOpenClawAgentDatabase({ agentId: `filler-${index}`, env });
    }
    expect(evicted.db.isOpen).toBe(false);

    const reopened = openOpenClawAgentDatabase({ agentId: "evicted", env });
    expect(reopened).not.toBe(evicted);
    expect(
      reopened.db
        .prepare("SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = ?")
        .get("cache-eviction"),
    ).toEqual({ state_json: JSON.stringify({ preserved: true }), updated_at: 42 });
  });
});
