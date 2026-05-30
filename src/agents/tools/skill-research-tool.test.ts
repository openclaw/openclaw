import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createSkillResearchTool } from "./skill-research-tool.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;
let stateDir = "";

beforeEach(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  stateDir = await tempDirs.make("openclaw-skill-research-state-");
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(async () => {
  envSnapshot.restore();
  await tempDirs.cleanup();
});

describe("skill_research tool", () => {
  it("is exposed in the OpenClaw tool set", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-research-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
    });
    expect(tools.some((tool) => tool.name === "skill_research")).toBe(true);
  });

  it("creates pending skill proposals without applying them", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-research-tool-");
    const tool = createSkillResearchTool({ workspaceDir, config: {}, agentId: "main" });

    const result = await tool.execute("call-1", {
      action: "create",
      name: "Weather Planner",
      description: "Plan around current weather",
      proposal_content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      goal: "Reuse weather planning steps",
    });

    expect(result.details).toMatchObject({
      status: "pending",
      kind: "create",
      skillKey: "weather-planner",
      scanState: "clean",
    });
    await expect(
      fs.readFile(
        path.join(
          stateDir,
          "skill-workshop",
          "proposals",
          (result.details as { id: string }).id,
          "PROPOSAL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("status: proposal");
    await expect(
      fs.access(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md")),
    ).rejects.toThrow();
  });
});
