import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { discoverPersistenceArtifacts, migratePersistenceToPostgres } from "./storage.js";

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("persistence storage discovery", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("discovers legacy state artifacts and summarizes dry-run migration", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persistence-discovery-"));
    const stateDir = path.join(tempRoot, ".openclaw");
    const workspaceDir = path.join(tempRoot, "workspace");

    await writeJson(path.join(stateDir, "agents", "main", "sessions", "sessions.json"), {
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });
    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "agents", "main", "sessions", "session-1.jsonl"),
      `${JSON.stringify({ type: "session", id: "session-1", version: 1 })}\n${JSON.stringify({
        type: "message",
        message: { role: "user", content: "hi" },
      })}\n`,
      "utf8",
    );
    await writeJson(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test",
        },
      },
    });
    await writeJson(path.join(stateDir, "subagents", "runs.json"), {
      version: 2,
      runs: {
        run_1: {
          runId: "run_1",
          childSessionKey: "child",
          requesterSessionKey: "requester",
          requesterDisplayKey: "requester",
          task: "work",
          cleanup: "keep",
          createdAt: 1,
        },
      },
    });
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "memory", "2026-03-11.md"), "# Daily\n", "utf8");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const artifacts = await discoverPersistenceArtifacts(cfg, env);
    expect(artifacts.sessionStores).toHaveLength(1);
    expect(artifacts.transcripts).toHaveLength(1);
    expect(artifacts.authStores).toHaveLength(1);
    expect(artifacts.subagentRegistryPath).toContain("subagents/runs.json");
    expect(artifacts.memoryDocuments.map((entry) => entry.logicalPath).toSorted()).toEqual([
      "MEMORY.md",
      "memory/2026-03-11.md",
    ]);

    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const summary = await migratePersistenceToPostgres({
        dryRun: true,
        cfg,
      });
      expect(summary).toMatchObject({
        dryRun: true,
        sessionStores: 1,
        sessions: 1,
        transcripts: 1,
        transcriptEvents: 2,
        authStores: 1,
        subagentRuns: 1,
        memoryDocuments: 2,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
