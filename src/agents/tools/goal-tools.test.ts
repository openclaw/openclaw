// Goal tool tests cover goal accounting projection, atomic clear-and-archive,
// terminal-only guard, and create_goal lifecycle contract.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, upsertSessionEntry } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createClearGoalTool, createCreateGoalTool, createGetGoalTool } from "./goal-tools.js";

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

describe("create_goal lifecycle (v02 contract)", () => {
  it("rejects creation when a complete goal already exists, pointing the model at clear_goal", async () => {
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
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    // v02 contract: create_goal does NOT auto-archive. It throws, telling the
    // model to call clear_goal first. This preserves the documented lifecycle
    // and is the only safe way to handle a complete/blocked goal.
    await expect(tool.execute("call-1", { objective: "next" })).rejects.toThrow(
      /clear_goal first/i,
    );

    // The prior goal is untouched; the session file has no clearedGoals.
    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.goal?.id).toBe("goal-prior");
    expect(entry?.clearedGoals ?? []).toHaveLength(0);
  });

  it("rejects creation when the existing goal is active (operator/session control territory)", async () => {
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
    const tool = createCreateGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    await expect(tool.execute("call-1", { objective: "next" })).rejects.toThrow(/Active goals/i);
    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.goal?.objective).toBe("in-flight");
  });
});

describe("clear_goal tool (v02 contract)", () => {
  it("atomically appends to clearedGoals and removes goal in one write", async () => {
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
    const tool = createClearGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const result = (await tool.execute("call-1", { note: "manual clear" })) as {
      details: { status: string; cleared?: { id: string; clearedFromStatus: string } };
    };

    expect(result.details.status).toBe("cleared");
    expect(result.details.cleared?.id).toBe("goal-complete");
    expect(result.details.cleared?.clearedFromStatus).toBe("complete");

    // Atomic write verification: both effects visible in the same load.
    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.goal).toBeUndefined();
    expect(entry?.clearedGoals).toHaveLength(1);
    expect(entry?.clearedGoals?.[0]?.id).toBe("goal-complete");
    expect(entry?.clearedGoals?.[0]?.objective).toBe("ship feature X");
    expect(entry?.clearedGoals?.[0]?.clearedFromStatus).toBe("complete");
    expect(entry?.clearedGoals?.[0]?.clearNote).toBe("manual clear");
  });

  it("rejects clear_goal on an active goal (terminal-only guard)", async () => {
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
    const tool = createClearGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    await expect(tool.execute("call-1", {})).rejects.toThrow(/'active'/i);

    // The active goal is untouched and no archive entry was created.
    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.goal?.id).toBe("goal-active");
    expect(entry?.clearedGoals ?? []).toHaveLength(0);
  });

  it("returns no-op when there is no goal to clear", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });
    const tool = createClearGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const result = (await tool.execute("call-1", {})) as {
      details: { status: string; reason?: string };
    };
    expect(result.details.status).toBe("no-op");
    expect(result.details.reason).toBe("no goal to clear");
  });

  it("prunes clearedGoals to clearedGoalsRetained (FIFO, oldest first)", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    // Seed three existing cleared entries (synthesized via direct store write).
    const seedEntry: import("../../config/sessions/types.js").SessionEntry = {
      sessionId: "sess-global",
      updatedAt: 1,
      clearedGoals: [
        {
          id: "g0",
          objective: "a",
          clearedFromStatus: "complete",
          clearedAt: 1,
          createdAt: 1,
          updatedAt: 1,
          tokensUsed: 0,
        },
        {
          id: "g1",
          objective: "b",
          clearedFromStatus: "complete",
          clearedAt: 2,
          createdAt: 2,
          updatedAt: 2,
          tokensUsed: 0,
        },
        {
          id: "g2",
          objective: "c",
          clearedFromStatus: "complete",
          clearedAt: 3,
          createdAt: 3,
          updatedAt: 3,
          tokensUsed: 0,
        },
      ],
      goal: {
        schemaVersion: 1,
        id: "g-current",
        objective: "current",
        status: "complete",
        createdAt: 4,
        updatedAt: 4,
        tokenStart: 0,
        tokenStartFresh: true,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    };
    await upsertSessionEntry({ storePath, sessionKey: "global", entry: seedEntry });

    // Retain 2 → after the new clear, we should have g2 + the new entry.
    const tool = createClearGoalTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
      clearedGoalsRetained: 2,
    });
    await tool.execute("call-1", {});

    const entry = loadSessionStore(storePath, { skipCache: true }).global;
    expect(entry?.clearedGoals).toHaveLength(2);
    expect(entry?.clearedGoals?.[0]?.id).toBe("g2");
    expect(entry?.clearedGoals?.[1]?.id).toBe("g-current");
  });
});
