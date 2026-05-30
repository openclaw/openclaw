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
      support_files: [
        {
          path: "references/weather.md",
          content: "Use weather API details.\n",
        },
      ],
      goal: "Reuse weather planning steps",
    });

    expect(result.details).toMatchObject({
      status: "pending",
      kind: "create",
      skillKey: "weather-planner",
      scanState: "clean",
      supportFileCount: 1,
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
      fs.readFile(
        path.join(
          stateDir,
          "skill-workshop",
          "proposals",
          (result.details as { id: string }).id,
          "references",
          "weather.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Use weather API details.");
    await expect(
      fs.access(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md")),
    ).rejects.toThrow();

    const revised = await tool.execute("call-2", {
      action: "revise",
      proposal_id: (result.details as { id: string }).id,
      proposal_content: "# Weather Planner\n\nCheck weather, alerts, and timing.\n",
      support_files: [
        {
          path: "references/weather.md",
          content: "Use weather API details and current alerts.\n",
        },
      ],
      evidence: "User asked for more precise planning.",
    });

    expect(revised.details).toMatchObject({
      id: (result.details as { id: string }).id,
      status: "pending",
      kind: "create",
      skillKey: "weather-planner",
      supportFileCount: 1,
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
    ).resolves.toContain('version: "v2"');

    const listed = await tool.execute("call-3", {
      action: "list",
      status: "pending",
      query: "weather",
    });

    expect((listed.content[0] as { text: string }).text).toContain("weather-planner");
    expect(
      (listed.details as { proposals: Array<{ id: string; skillKey: string }> }).proposals,
    ).toEqual([
      expect.objectContaining({
        id: (result.details as { id: string }).id,
        skillKey: "weather-planner",
      }),
    ]);

    const inspected = await tool.execute("call-4", {
      action: "inspect",
      name: "weather-planner",
    });

    expect((inspected.content[0] as { text: string }).text).toContain(
      "Proposal: " + (result.details as { id: string }).id,
    );
    expect((inspected.details as { proposalContent: string }).proposalContent).toContain(
      "Check weather, alerts, and timing.",
    );

    const revisedByName = await tool.execute("call-5", {
      action: "revise",
      name: "weather-planner",
      proposal_content: "# Weather Planner\n\nCheck weather, alerts, timing, and location.\n",
    });

    expect(revisedByName.details).toMatchObject({
      id: (result.details as { id: string }).id,
      proposedVersion: "v3",
      scanState: "clean",
    });
  });

  it("applies, rejects, and quarantines proposals through the workshop service", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-research-tool-");
    const tool = createSkillResearchTool({ workspaceDir, config: {}, agentId: "main" });

    const created = await tool.execute("call-1", {
      action: "create",
      name: "Weather Planner",
      description: "Plan around current weather",
      proposal_content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      support_files: [
        {
          path: "references/weather.md",
          content: "Use weather API details.\n",
        },
      ],
    });
    const createdId = (created.details as { id: string }).id;

    const applied = await tool.execute("call-2", {
      action: "apply",
      proposal_id: createdId,
      reason: "user approved the proposal",
    });

    expect((applied.content[0] as { text: string }).text).toContain(
      `Applied skill proposal ${createdId}.`,
    );
    expect(applied.details).toMatchObject({
      id: createdId,
      status: "applied",
      kind: "create",
      skillKey: "weather-planner",
      scanState: "clean",
    });
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("Check weather before outdoor recommendations.");
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.not.toContain("status: proposal");
    await expect(
      fs.readFile(
        path.join(workspaceDir, "skills", "weather-planner", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use weather API details.");

    const rejected = await tool.execute("call-3", {
      action: "create",
      name: "Rejected Skill",
      description: "Rejected proposal",
      proposal_content: "# Rejected Skill\n\nDo not apply this.\n",
    });
    const rejectedId = (rejected.details as { id: string }).id;
    const rejectResult = await tool.execute("call-4", {
      action: "reject",
      proposal_id: rejectedId,
      reason: "not needed",
    });

    expect((rejectResult.content[0] as { text: string }).text).toContain(
      `Rejected skill proposal ${rejectedId}.`,
    );
    expect(rejectResult.details).toMatchObject({
      id: rejectedId,
      status: "rejected",
      kind: "create",
      skillKey: "rejected-skill",
    });
    await expect(
      fs.access(path.join(workspaceDir, "skills", "rejected-skill", "SKILL.md")),
    ).rejects.toThrow();

    const quarantined = await tool.execute("call-5", {
      action: "create",
      name: "Quarantined Skill",
      description: "Quarantined proposal",
      proposal_content: "# Quarantined Skill\n\nDo not apply this.\n",
    });
    const quarantinedId = (quarantined.details as { id: string }).id;
    const quarantineResult = await tool.execute("call-6", {
      action: "quarantine",
      proposal_id: quarantinedId,
      reason: "unsafe for now",
    });

    expect((quarantineResult.content[0] as { text: string }).text).toContain(
      `Quarantined skill proposal ${quarantinedId}.`,
    );
    expect(quarantineResult.details).toMatchObject({
      id: quarantinedId,
      status: "quarantined",
      kind: "create",
      skillKey: "quarantined-skill",
      scanState: "quarantined",
    });
    await expect(
      fs.access(path.join(workspaceDir, "skills", "quarantined-skill", "SKILL.md")),
    ).rejects.toThrow();
  });
});
