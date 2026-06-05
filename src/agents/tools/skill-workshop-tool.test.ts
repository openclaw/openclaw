// skill_workshop tests cover proposal creation/revision/listing without
// applying generated skills to the workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;
let stateDir = "";

beforeEach(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  stateDir = await tempDirs.make("openclaw-skill-workshop-state-");
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(async () => {
  envSnapshot.restore();
  await tempDirs.cleanup();
});

describe("skill_workshop tool", () => {
  it("is exposed in the OpenClaw tool set", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
    });
    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(true);
  });

  it("stays exposed when autonomous proposal capture is disabled", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: false,
            },
          },
        },
      },
      disablePluginTools: true,
    });
    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(true);
  });

  it("is not exposed from sandboxed OpenClaw tool sets", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
      sandboxed: true,
    });

    expect(tools.some((tool) => tool.name === "skill_workshop")).toBe(false);
  });

  it("creates pending skill proposals without applying them", async () => {
    // Creation writes reviewable proposal artifacts under state, not live skill
    // files in the workspace.
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
      origin: {
        agentId: "main",
        sessionKey: "agent:main:dashboard:workshop-test",
        runId: "run-workshop-test",
      },
    });

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
    expect((result.content[0] as { text: string }).text).toBe(
      `Created skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
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
      fs
        .readFile(
          path.join(
            stateDir,
            "skill-workshop",
            "proposals",
            (result.details as { id: string }).id,
            "proposal.json",
          ),
          "utf8",
        )
        .then((raw) => JSON.parse(raw).origin),
    ).resolves.toEqual({
      agentId: "main",
      sessionKey: "agent:main:dashboard:workshop-test",
      runId: "run-workshop-test",
    });
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
    expect((revised.content[0] as { text: string }).text).toBe(
      `Revised skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
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
    const punctuationOnly = await tool.execute("call-3b", {
      action: "list",
      status: "pending",
      query: "!!!",
    });
    expect((punctuationOnly.content[0] as { text: string }).text).toBe(
      "No skill proposals matched.",
    );
    expect((punctuationOnly.details as { proposals: unknown[] }).proposals).toEqual([]);

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
    expect((inspected.content[0] as { text: string }).text).toContain(
      "--- references/weather.md ---",
    );
    expect(
      (
        inspected.details as {
          supportFiles: Array<{ path: string; content: string }>;
        }
      ).supportFiles,
    ).toEqual([
      {
        path: "references/weather.md",
        content: "Use weather API details and current alerts.\n",
      },
    ]);

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
    expect((revisedByName.content[0] as { text: string }).text).toBe(
      `Revised skill proposal ${(result.details as { id: string }).id} (pending) for weather-planner.`,
    );
  });

  it("accepts support files from JSON-array strings", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({ workspaceDir, config: {}, agentId: "main" });

    const result = await tool.execute("call-1", {
      action: "create",
      name: "Release Captain",
      description: "Coordinate release readiness",
      proposal_content: "# Release Captain\n\nCollect release risks.\n",
      support_files: JSON.stringify([
        {
          path: "examples/release.md",
          content: "Example release checklist.\n",
        },
      ]),
      goal: "Reuse release planning steps",
    });

    expect(result.details).toMatchObject({
      status: "pending",
      kind: "create",
      skillKey: "release-captain",
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
          "examples",
          "release.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("Example release checklist.");
  });

  it("applies, rejects, and quarantines proposals through the workshop service", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({ workspaceDir, config: {}, agentId: "main" });

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

    const update = await tool.execute("call-update", {
      action: "update",
      skill_name: "weather-planner",
      description: "Refresh weather planning steps",
      proposal_content: "# Weather Planner\n\nCheck weather, alerts, and timing.\n",
    });

    expect((update.content[0] as { text: string }).text).toBe(
      `Created skill update proposal ${(update.details as { id: string }).id} (pending) for weather-planner.`,
    );
    expect(update.details).toMatchObject({
      status: "pending",
      kind: "update",
      skillKey: "weather-planner",
    });

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

  it("revises a same-name pending proposal through action=create", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
    });

    const created = await tool.execute("call-1", {
      action: "create",
      name: "Weekly Brief",
      description: "Draft a weekly operations brief",
      proposal_content: "# Weekly Brief\n\nSummarize updates.\n",
      evidence: "initial draft",
    });
    const revised = await tool.execute("call-2", {
      action: "create",
      name: "Weekly Brief",
      description: "Draft a sharper weekly operations brief",
      proposal_content: "# Weekly Brief\n\nSummarize updates and blockers.\n",
      evidence: "gate_summary: passed",
    });

    expect(revised.details).toMatchObject({
      id: (created.details as { id: string }).id,
      status: "pending",
      kind: "create",
      skillKey: "weekly-brief",
      proposedVersion: "v2",
    });
    expect((revised.content[0] as { text: string }).text).toBe(
      `Revised skill proposal ${(created.details as { id: string }).id} (pending) for weekly-brief.`,
    );
  });

  it("does not use fuzzy proposal matches when action=create auto-revises", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({ workspaceDir, config: {}, agentId: "main" });

    const planner = await tool.execute("call-1", {
      action: "create",
      name: "Weather Planner",
      description: "Plan around current weather",
      proposal_content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
    });

    const weather = await tool.execute("call-2", {
      action: "create",
      name: "Weather",
      description: "Check current weather",
      proposal_content: "# Weather\n\nFetch weather before answering.\n",
    });

    expect(weather.details).toMatchObject({
      status: "pending",
      kind: "create",
      skillKey: "weather",
      proposedVersion: "v1",
    });
    expect((weather.details as { id: string }).id).not.toBe((planner.details as { id: string }).id);
    expect((weather.content[0] as { text: string }).text).toBe(
      `Created skill proposal ${(weather.details as { id: string }).id} (pending) for weather.`,
    );
  });

  it("creates update proposals for existing writable skills through action=create", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const skillFile = path.join(workspaceDir, "skills", "weekly-brief", "SKILL.md");
    await writeSkill({
      dir: path.dirname(skillFile),
      name: "weekly-brief",
      description: "Old weekly brief workflow",
      body: "# Weekly Brief\n\nOld instructions.\n",
    });
    const tool = createSkillWorkshopTool({ workspaceDir, config: {}, agentId: "main" });

    const result = await tool.execute("call-1", {
      action: "create",
      name: "weekly-brief",
      description: "Draft a sharper weekly operations brief",
      proposal_content: "# Weekly Brief\n\nGather updates and summarize blockers.\n",
    });

    expect(result.details).toMatchObject({
      status: "pending",
      kind: "update",
      skillKey: "weekly-brief",
      targetSkillFile: skillFile,
    });
    expect((result.content[0] as { text: string }).text).toBe(
      `Created skill update proposal ${(result.details as { id: string }).id} (pending) for weekly-brief.`,
    );
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Old instructions.");
  });

  it("scopes proposal discovery to the tool workspace", async () => {
    const firstWorkspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-first-");
    const secondWorkspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-second-");
    const firstTool = createSkillWorkshopTool({
      workspaceDir: firstWorkspaceDir,
      config: {},
      agentId: "main",
    });
    const secondTool = createSkillWorkshopTool({
      workspaceDir: secondWorkspaceDir,
      config: {},
      agentId: "main",
    });

    const first = await firstTool.execute("call-1", {
      action: "create",
      name: "First Workspace Skill",
      description: "First workspace proposal",
      proposal_content: "# First\n",
    });
    const second = await secondTool.execute("call-2", {
      action: "create",
      name: "Second Workspace Skill",
      description: "Second workspace proposal",
      proposal_content: "# Second\n",
    });

    const listed = await firstTool.execute("call-3", {
      action: "list",
      status: "pending",
    });
    expect(
      (listed.details as { proposals: Array<{ id: string }> }).proposals.map(
        (proposal) => proposal.id,
      ),
    ).toEqual([(first.details as { id: string }).id]);
    await expect(
      firstTool.execute("call-4", {
        action: "inspect",
        proposal_id: (second.details as { id: string }).id,
      }),
    ).rejects.toThrow(`Skill proposal not found: ${(second.details as { id: string }).id}`);
  });
});
