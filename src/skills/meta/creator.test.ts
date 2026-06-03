import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { parseFrontmatter } from "../loading/frontmatter.js";
import type { Skill } from "../loading/skill-contract.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillEntry } from "../types.js";
import { inspectSkillProposal, listSkillProposals } from "../workshop/service.js";
import { buildMetaSkillCatalog } from "./catalog.js";
import { createSkillProposalFromMetaCreator, META_SKILL_CREATOR_TOOL_NAME } from "./creator.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;
let workspaceDir = "";

beforeEach(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  process.env.OPENCLAW_STATE_DIR = await tempDirs.make("openclaw-meta-creator-state-");
  workspaceDir = await tempDirs.make("openclaw-meta-creator-");
});

afterEach(async () => {
  envSnapshot.restore();
  await tempDirs.cleanup();
});

function skillEntryFromFile(filePath: string, source: string): SkillEntry {
  const name = path.basename(path.dirname(filePath));
  const skill: Skill = {
    name,
    description: `${name} description`,
    filePath,
    baseDir: path.dirname(filePath),
    source,
    sourceInfo: {
      path: filePath,
      source: "openclaw-bundled",
      scope: "project",
      origin: "top-level",
      baseDir: path.dirname(filePath),
    },
    disableModelInvocation: false,
  };
  return {
    skill,
    frontmatter: parseFrontmatter(source),
  };
}

describe("createSkillProposalFromMetaCreator", () => {
  it("creates a pending Skill Workshop proposal with gate evidence", async () => {
    const proposal = await createSkillProposalFromMetaCreator({
      workspaceDir,
      name: "weekly-brief",
      description: "Draft a weekly operations brief",
      content: "When asked for a weekly brief, gather updates and summarize them.",
      goal: "Capture repeated weekly brief workflow",
      evidence: "runtime_e2e: passed",
    });

    expect(proposal.record).toMatchObject({
      kind: "create",
      status: "pending",
      createdBy: "skill-workshop",
      goal: "Capture repeated weekly brief workflow",
      evidence: "runtime_e2e: passed",
      scan: {
        state: "clean",
      },
    });
    expect(proposal.content).toContain('name: "weekly-brief"');

    const list = await listSkillProposals({ workspaceDir });
    expect(list.proposals.some((entry) => entry.id === proposal.record.id)).toBe(true);
  });

  it("revises an existing pending proposal instead of creating a duplicate", async () => {
    const original = await createSkillProposalFromMetaCreator({
      workspaceDir,
      name: "weekly-brief",
      description: "Draft a weekly operations brief",
      content: "# Weekly Brief\n\nOriginal body.\n",
      goal: "Capture repeated weekly brief workflow",
      evidence: "runtime_e2e: passed",
    });

    const revised = await createSkillProposalFromMetaCreator({
      workspaceDir,
      name: "weekly-brief",
      description: "Draft a sharper weekly operations brief",
      content: "# Weekly Brief\n\nRevised body.\n",
      evidence: "gate_summary: passed",
    });

    expect(revised.record).toMatchObject({
      id: original.record.id,
      kind: "create",
      status: "pending",
      proposedVersion: "v2",
      evidence: "gate_summary: passed",
    });
    expect(revised.content).toContain('version: "v2"');
    expect(revised.content).toContain("Revised body.");
    const list = await listSkillProposals({ workspaceDir });
    expect(list.proposals.filter((entry) => entry.skillKey === "weekly-brief")).toHaveLength(1);
  });

  it("creates update proposals when an existing writable skill is named", async () => {
    const skillFile = path.join(workspaceDir, "skills", "weekly-brief", "SKILL.md");
    await writeSkill({
      dir: path.dirname(skillFile),
      name: "weekly-brief",
      description: "Old weekly brief workflow",
      body: "# Weekly Brief\n\nOld instructions.\n",
    });

    const proposal = await createSkillProposalFromMetaCreator({
      workspaceDir,
      name: "weekly-brief",
      description: "Draft a sharper weekly operations brief",
      content: "# Weekly Brief\n\nGather updates and summarize blockers.\n",
      supportFiles: [
        {
          path: "references/template.md",
          content: "# Weekly Template\n\n- Wins\n- Risks\n",
        },
      ],
      evidence: "gate_summary: passed",
    });

    expect(proposal.record).toMatchObject({
      kind: "update",
      status: "pending",
      evidence: "gate_summary: passed",
      target: {
        skillName: "weekly-brief",
        skillFile,
      },
    });
    await expect(inspectSkillProposal(proposal.record.id, { workspaceDir })).resolves.toMatchObject(
      {
        supportFiles: [
          {
            path: "references/template.md",
            content: "# Weekly Template\n\n- Wins\n- Risks\n",
          },
        ],
      },
    );
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "weekly-brief", "SKILL.md"), "utf8"),
    ).resolves.toContain("Old instructions.");
  });

  it("does not route same-name bundled skills through the update path", async () => {
    const bundledSkill = buildWorkspaceSkillStatus(workspaceDir).skills.find(
      (skill) => skill.skillKey === "skill-creator",
    );
    expect(bundledSkill?.source).toBe("openclaw-bundled");

    const proposal = await createSkillProposalFromMetaCreator({
      workspaceDir,
      name: "skill-creator",
      description: "Capture a local override proposal",
      content: "# Skill Creator\n\nLocal proposal body.\n",
      evidence: "gate_summary: passed",
    });

    expect(proposal.record).toMatchObject({
      kind: "create",
      status: "pending",
      target: {
        skillKey: "skill-creator",
      },
    });
  });

  it("keeps the shipped meta-skill creator parseable and wired to the creator bridge", async () => {
    const skillFile = path.resolve("skills/meta-skill-creator/SKILL.md");
    const source = await fs.readFile(skillFile, "utf8");

    const catalog = buildMetaSkillCatalog([skillEntryFromFile(skillFile, source)]);

    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plans).toHaveLength(1);
    const plan = catalog.plans[0];
    expect(plan).toMatchObject({
      name: "meta-skill-creator",
      finalTextMode: { kind: "step", stepId: "proposal" },
    });
    const proposalStep = plan.steps.find((step) => step.id === "proposal");
    expect(proposalStep).toMatchObject({
      kind: "tool_call",
      toolName: META_SKILL_CREATOR_TOOL_NAME,
      args: {
        name: "{{collect.name}}",
        description: "{{collect.description}}",
        content: "{{collect.content}}",
        goal: "Created by meta-skill-creator",
        evidence: "creator workflow collected: {{collect.workflow}}",
      },
    });
    expect(proposalStep?.args).not.toHaveProperty("action");
    expect(proposalStep?.args).not.toHaveProperty("proposal_content");
  });
});
