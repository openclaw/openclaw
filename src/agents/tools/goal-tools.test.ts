// Goal tool tests cover goal accounting projection and correct session-store
// routing for global and scoped sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, upsertSessionEntry } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCreateGoalTool, createClearGoalTool, createGetGoalTool } from "./goal-tools.js";

async function createStoreConfig(): Promise<{ config: OpenClawConfig; template: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-goal-tools-"));
  const template = path.join(dir, "{agentId}", "sessions.json");
  return {
    config: { session: { store: template } } as OpenClawConfig,
    template,
  };
}

describe("goal tools", () => {
  it("keeps get_goal read-only when accounting changes are projected", async () => {
    // Budget-limited status can be derived for display without mutating the
    // stored active goal record.
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        totalTokens: 125,
        totalTokensFresh: true,
        goal: {
          schemaVersion: 1,
          id: "goal-1",
          objective: "ship",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 0,
          tokenBudget: 20,
          continuationTurns: 0,
        },
      },
    });
    const tool = createGetGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const result = await tool.execute("call-1", {});

    expect((result.details as { goal?: { status?: string } }).goal?.status).toBe("budget_limited");
    expect(loadSessionStore(storePath, { skipCache: true }).global?.goal?.status).toBe("active");
  });

  it("uses the resolved session agent for global session stores", async () => {
    const { config, template } = await createStoreConfig();
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const researchStorePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath: researchStorePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship global work" });

    const mainStorePath = resolveStorePath(template, { agentId: "main" });
    expect(loadSessionStore(researchStorePath, { skipCache: true }).global?.goal?.objective).toBe(
      "ship global work",
    );
    expect(loadSessionStore(mainStorePath, { skipCache: true }).global?.goal).toBeUndefined();
  });

  it("prefers scoped run session keys over the fallback session agent", async () => {
    const { config, template } = await createStoreConfig();
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "agent:ops:main",
      sessionAgentId: "research",
      config,
    });

    const opsStorePath = resolveStorePath(template, { agentId: "ops" });
    await upsertSessionEntry({
      storePath: opsStorePath,
      sessionKey: "agent:ops:main",
      entry: { sessionId: "sess-ops", updatedAt: 1 },
    });
    await tool.execute("call-1", { objective: "ship ops work" });

    const researchStorePath = resolveStorePath(template, { agentId: "research" });
    expect(
      loadSessionStore(opsStorePath, { skipCache: true })["agent:ops:main"]?.goal?.objective,
    ).toBe("ship ops work");
    expect(
      loadSessionStore(researchStorePath, { skipCache: true })["agent:ops:main"]?.goal,
    ).toBeUndefined();
  });
});

describe("clear_goal tool", () => {
  it("archives a complete goal to memory/goal-archive.jsonl before clearing", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-complete",
          objective: "ship feature X",
          status: "complete",
          createdAt: 1,
          updatedAt: 2,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 50,
          tokenBudget: 100,
          continuationTurns: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clear-archive-"));
    const tool = createClearGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
      workspaceDir,
    });

    const result = (await tool.execute("call-1", { note: "manual clear" })) as {
      details: { status: string; wasArchived: boolean };
    };

    expect(result.details.status).toBe("cleared");
    expect(result.details.wasArchived).toBe(true);
    expect(loadSessionStore(storePath, { skipCache: true }).global?.goal).toBeUndefined();

    const archivePath = path.join(workspaceDir, "memory", "goal-archive.jsonl");
    const lines = (await fs.readFile(archivePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.id).toBe("goal-complete");
    expect(record.objective).toBe("ship feature X");
    expect(record.status).toBe("complete");
    expect(record.clearNote).toBe("manual clear");
  });

  it("does not archive when archive=false", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-blocked",
          objective: "blocked objective",
          status: "blocked",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 0,
          tokenBudget: 100,
          continuationTurns: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-clear-noarchive-"));
    const tool = createClearGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
      workspaceDir,
    });

    const result = (await tool.execute("call-1", { archive: false })) as {
      details: { status: string; wasArchived: boolean };
    };

    expect(result.details.status).toBe("cleared");
    expect(result.details.wasArchived).toBe(false);
    const archivePath = path.join(workspaceDir, "memory", "goal-archive.jsonl");
    await expect(fs.access(archivePath)).rejects.toThrow();
  });

  it("create_goal auto-archives a terminal goal and replaces it", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-prior",
          objective: "prior objective",
          status: "complete",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 0,
          tokenBudget: 100,
          continuationTurns: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replace-archive-"));
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
      workspaceDir,
    });

    await tool.execute("call-1", { objective: "next objective" });

    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.goal?.objective).toBe("next objective");
    expect(entry?.goal?.status).toBe("active");

    const archivePath = path.join(workspaceDir, "memory", "goal-archive.jsonl");
    const lines = (await fs.readFile(archivePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe("goal-prior");
  });

  it("create_goal still blocks when the existing goal is active", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: {
        sessionId: "sess-global",
        updatedAt: 1,
        goal: {
          schemaVersion: 1,
          id: "goal-active",
          objective: "in-flight",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokenStartFresh: true,
          tokensUsed: 0,
          tokenBudget: 100,
          continuationTurns: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-blocked-archive-"));
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
      workspaceDir,
    });

    await expect(tool.execute("call-1", { objective: "next" })).rejects.toThrow();

    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.goal?.objective).toBe("in-flight");
    const archivePath = path.join(workspaceDir, "memory", "goal-archive.jsonl");
    await expect(fs.access(archivePath)).rejects.toThrow();
  });
});
