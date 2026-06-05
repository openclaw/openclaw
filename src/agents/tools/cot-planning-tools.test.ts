import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionStore, upsertSessionEntry } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createSetGoalPlanTool,
  createUpdateGoalPlanStepTool,
} from "./cot-planning-tools.js";

async function createStoreConfig(): Promise<{ config: OpenClawConfig; template: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cot-tools-"));
  const template = path.join(dir, "{agentId}", "sessions.json");
  return {
    config: { session: { store: template } } as OpenClawConfig,
    template,
  };
}

describe("CoT planning tools", () => {
  it("fails to set plan if there is no active goal", async () => {
    const { config, template } = await createStoreConfig();
    const storePath = resolveStorePath(template, { agentId: "research" });
    await upsertSessionEntry({
      storePath,
      sessionKey: "global",
      entry: { sessionId: "sess-global", updatedAt: 1 },
    });

    const tool = createSetGoalPlanTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    await expect(
      tool.execute("call-1", {
        approach: "Invalid attempt",
        steps: [{ id: "s1", description: "First step" }],
      }),
    ).rejects.toThrow("no active goal");
  });

  it("successfully sets and replaces a plan on the active goal", async () => {
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
          id: "goal-1",
          objective: "do work",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    });

    const setTool = createSetGoalPlanTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    const planPayload = {
      approach: "Build the feature cleanly.",
      steps: [
        { id: "s1", description: "Design schema" },
        { id: "s2", description: "Write tests", depends_on: ["s1"], checkpoint: true, estimated_tokens: 5000 },
      ],
      risks: ["Syntax mismatch"],
      checkpoints: ["Compile check"],
    };

    const res = await setTool.execute("call-1", planPayload);
    expect(res.details).toEqual({
      status: "plan_set",
      steps: 2,
      approach: "Build the feature cleanly.",
    });

    const storedGoal = loadSessionStore(storePath, { skipCache: true }).global?.goal;
    expect(storedGoal?.planSnapshot).toBeDefined();
    expect(storedGoal?.planSnapshot?.approach).toBe("Build the feature cleanly.");
    expect(storedGoal?.planSnapshot?.steps.length).toBe(2);
    expect(storedGoal?.planSnapshot?.steps[1].dependsOn).toEqual(["s1"]);
    expect(storedGoal?.planSnapshot?.steps[1].checkpoint).toBe(true);
    expect(storedGoal?.planSnapshot?.steps[1].estimatedTokens).toBe(5000);
    expect(storedGoal?.planSnapshot?.risks).toEqual(["Syntax mismatch"]);
  });

  it("validates steps against duplicates and missing dependencies", async () => {
    const { config } = await createStoreConfig();
    const setTool = createSetGoalPlanTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    // Duplicate IDs
    await expect(
      setTool.execute("call-1", {
        approach: "invalid",
        steps: [
          { id: "s1", description: "Step A" },
          { id: "s1", description: "Step B" },
        ],
      }),
    ).rejects.toThrow("duplicate step id: s1");

    // Unknown dependency
    await expect(
      setTool.execute("call-1", {
        approach: "invalid",
        steps: [
          { id: "s1", description: "Step A", depends_on: ["s99"] },
        ],
      }),
    ).rejects.toThrow("step s1 depends on unknown step: s99");
  });

  it("updates step status correctly and handles notes", async () => {
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
          id: "goal-1",
          objective: "do work",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 100,
          tokensUsed: 0,
          continuationTurns: 0,
          planSnapshot: {
            schemaVersion: 1,
            createdAt: 1,
            approach: "test approach",
            steps: [
              { id: "s1", description: "Step 1", status: "pending" },
              { id: "s2", description: "Step 2", status: "pending" },
            ],
          },
        },
      },
    });

    const updateTool = createUpdateGoalPlanStepTool({
      agentSessionKey: "global",
      runSessionKey: "global",
      sessionAgentId: "research",
      config,
    });

    // Update s1 to active
    let res = await updateTool.execute("call-1", {
      step_id: "s1",
      status: "active",
    });
    expect(res.details).toEqual({
      status: "step_updated",
      step: { id: "s1", status: "active", description: "Step 1" },
    });

    // Update s1 to done with note
    res = await updateTool.execute("call-2", {
      step_id: "s1",
      status: "done",
      note: "setup completed",
    });
    expect(res.details).toEqual({
      status: "step_updated",
      step: { id: "s1", status: "done", description: "Step 1", note: "setup completed" },
    });

    // Verify stored state
    const storedGoal = loadSessionStore(storePath, { skipCache: true }).global?.goal;
    expect(storedGoal?.planSnapshot?.steps[0].status).toBe("done");
    expect(storedGoal?.planSnapshot?.steps[0].note).toBe("setup completed");
    expect(storedGoal?.planSnapshot?.steps[1].status).toBe("pending");

    // Invalid step_id
    await expect(
      updateTool.execute("call-3", {
        step_id: "s99",
        status: "active",
      }),
    ).rejects.toThrow("unknown step id: s99");
  });
});
