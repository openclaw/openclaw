import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSkillsManageProposalsForTests } from "../skills/skills-manage-proposals.js";
import { createSkillsManageTool } from "./skills-manage-tool.js";

const goodSkillMd = [
  "## Purpose / When to use",
  "Use when deploying services.",
  "## Do not use for",
  "One-off debugging.",
  "## Inputs / prerequisites",
  "kubectl context.",
  "## Procedure",
  "1. Run tests.",
  "2. Deploy.",
  "## Verification",
  "Check pods are ready.",
  "## Pitfalls / failure recovery",
  "If apply fails, roll back.",
  "## Safety constraints",
  "Do not delete production namespaces without approval.",
].join("\n");

afterEach(() => {
  __resetSkillsManageProposalsForTests();
});

type SkillsManageProposeDetails = {
  status: string;
  persisted?: boolean;
  proposalId?: string;
  quality?: { score: number };
  errorCode?: string;
};

describe("createSkillsManageTool", () => {
  it("includes recovery-oriented description keys", () => {
    const tool = createSkillsManageTool({
      workspaceDir: "/tmp",
      config: {},
    });
    expect(tool.name).toBe("skills_manage");
    expect(tool.description).toMatch(/approve/);
    expect(tool.description).toMatch(/RECOVERY/);
  });

  it("propose returns persisted false and proposalId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smt-"));
    const tool = createSkillsManageTool({ workspaceDir: root, config: {} });
    const res = await tool.execute("t1", {
      action: "propose",
      name: "demo-skill",
      content: goodSkillMd,
      targetRoot: "workspace",
    });
    const payload = res.details as SkillsManageProposeDetails;
    expect(payload.status).toBe("ok");
    expect(payload.persisted).toBe(false);
    expect(typeof payload.proposalId).toBe("string");
    expect(typeof payload.quality?.score).toBe("number");
    expect((payload.quality?.score ?? 0) >= 8).toBe(true);
  });

  it("rejects propose with proposalId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smt-"));
    const tool = createSkillsManageTool({ workspaceDir: root, config: {} });
    const res = await tool.execute("t2", {
      action: "propose",
      name: "x",
      content: goodSkillMd,
      proposalId: "sp_bad",
    });
    const payload = res.details as SkillsManageProposeDetails;
    expect(payload.status).toBe("error");
    expect(payload.errorCode).toBe("invalid_action_arguments");
  });

  it("rejects invalid targetRoot in update", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smt-"));
    const skillDir = path.join(root, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), goodSkillMd, "utf8");
    const tool = createSkillsManageTool({ workspaceDir: root, config: {} });
    const res = await tool.execute("t3", {
      action: "update",
      name: "demo-skill",
      content: goodSkillMd,
      targetRoot: "workspace-typo",
    });
    const payload = res.details as SkillsManageProposeDetails;
    expect(payload.status).toBe("error");
    expect(payload.errorCode).toBe("invalid_action_arguments");
  });
});
