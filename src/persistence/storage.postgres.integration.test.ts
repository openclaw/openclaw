import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import {
  getPostgresPersistenceWithMode,
  quoteSqlIdentifier,
  resetPostgresPersistenceForTest,
} from "./postgres-client.js";
import { migratePersistenceToPostgres, verifyPostgresPersistence } from "./storage.js";

const POSTGRES_URL = process.env.OPENCLAW_TEST_POSTGRES_URL?.trim();

describe.skipIf(!POSTGRES_URL)("storage postgres integration", () => {
  let tempRoot = "";
  let previousStateDir: string | undefined;
  let schema = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-storage-postgres-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    schema = `openclaw_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  });

  afterEach(async () => {
    const client = await getPostgresPersistenceWithMode("configured");
    if (client && schema) {
      await client.sql.unsafe(`drop schema if exists ${quoteSqlIdentifier(schema)} cascade`);
    }
    await resetPostgresPersistenceForTest();
    clearRuntimeConfigSnapshot();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("imports discovered artifacts and verifies them against PostgreSQL", async () => {
    const stateDir = path.join(tempRoot, ".openclaw");
    const workspaceDir = path.join(tempRoot, "workspace");
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      `${JSON.stringify({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: 1,
        },
      })}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "agents", "main", "sessions", "session-1.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: new Date().toISOString(),
        cwd: workspaceDir,
      })}\n${JSON.stringify({
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      })}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
      `${JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      })}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(stateDir, "subagents"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "subagents", "runs.json"),
      `${JSON.stringify({
        version: 2,
        runs: {
          run_1: {
            runId: "run_1",
            childSessionKey: "agent:main:subagent:test",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "work",
            cleanup: "keep",
            createdAt: 1,
          },
        },
      })}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-03-11.md"), "# Daily\n", "utf8");

    const cfg: OpenClawConfig = {
      persistence: {
        postgres: {
          url: POSTGRES_URL,
          schema,
          maxConnections: 1,
          encryptionKey: "integration-test-key",
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    setRuntimeConfigSnapshot(cfg);
    await resetPostgresPersistenceForTest();

    const summary = await migratePersistenceToPostgres({ cfg });
    expect(summary).toMatchObject({
      dryRun: false,
      sessionStores: 1,
      sessions: 1,
      transcripts: 1,
      transcriptEvents: 2,
      authStores: 1,
      subagentRuns: 1,
      memoryDocuments: 2,
    });

    const report = await verifyPostgresPersistence(cfg);
    expect(report.matches).toBe(true);
    expect(report.mismatches).toEqual([]);
  });
});
