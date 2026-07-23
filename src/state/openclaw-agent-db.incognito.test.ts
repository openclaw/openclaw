import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("incognito agent database", () => {
  it("boots the canonical schema in one cached memory handle without touching its sentinel path", () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-incognito-db-")),
    );
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });

    const first = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    const reopened = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });

    expect(reopened).toBe(first);
    expect(
      first.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'")
        .get(),
    ).toEqual({ name: "sessions" });
    expect(first.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 13 });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.dirname(sentinel))).toBe(false);
  });
});
