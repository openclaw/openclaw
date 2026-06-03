import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createMetaSkillCreatorTool } from "./meta-skill-creator-tool.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  process.env.OPENCLAW_STATE_DIR = await tempDirs.make("openclaw-meta-skill-creator-tool-state-");
});

afterEach(async () => {
  envSnapshot.restore();
  await tempDirs.cleanup();
});

describe("meta_skill_creator tool", () => {
  it("is exposed in the non-sandboxed OpenClaw tool set", async () => {
    const workspaceDir = await tempDirs.make("openclaw-meta-skill-creator-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
    });

    expect(tools.some((tool) => tool.name === "meta_skill_creator")).toBe(true);
  });

  it("is not exposed from sandboxed OpenClaw tool sets", async () => {
    const workspaceDir = await tempDirs.make("openclaw-meta-skill-creator-tool-");
    const tools = createOpenClawTools({
      workspaceDir,
      config: {},
      disablePluginTools: true,
      sandboxed: true,
    });

    expect(tools.some((tool) => tool.name === "meta_skill_creator")).toBe(false);
  });

  it("creates and revises pending proposals through the meta creator helper", async () => {
    const workspaceDir = await tempDirs.make("openclaw-meta-skill-creator-tool-");
    const tool = createMetaSkillCreatorTool({
      workspaceDir,
      config: {},
      agentId: "main",
      origin: {
        agentId: "main",
        sessionKey: "agent:main:dashboard:meta-creator-test",
        runId: "run-meta-creator-test",
      },
    });

    const created = await tool.execute("call-1", {
      name: "Weekly Brief",
      description: "Draft a weekly operations brief",
      content: "# Weekly Brief\n\nSummarize updates.\n",
      evidence: "creator draft completed",
    });
    expect(created.details).toMatchObject({
      status: "pending",
      kind: "create",
      skillKey: "weekly-brief",
      scanState: "clean",
      proposedVersion: "v1",
    });

    const revised = await tool.execute("call-2", {
      name: "Weekly Brief",
      description: "Draft a sharper weekly operations brief",
      content: "# Weekly Brief\n\nSummarize updates and blockers.\n",
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
      `Prepared skill proposal ${(created.details as { id: string }).id} (pending) for weekly-brief.`,
    );
  });
});
