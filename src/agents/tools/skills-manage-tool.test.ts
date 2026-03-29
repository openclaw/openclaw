import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../../test-utils/temp-dir.js";
import {
  clearProposalsForTests,
  createProposal,
  resolveSkillRoot,
  setProposalForTests,
} from "../skills/skills-manage-proposals.js";
import { createSkillsManageTool } from "./skills-manage-tool.js";

function getDetails(result: unknown): Record<string, unknown> {
  return ((result as { details?: unknown }).details ?? {}) as Record<string, unknown>;
}

function getStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

afterEach(() => {
  clearProposalsForTests();
});

describe("skills_manage tool", () => {
  it("propose returns preview and does not write files", async () => {
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const result = await tool.execute("call-1", {
        action: "propose",
        name: "Deploy API",
        contents: "# Deploy API\n\nUse these deployment steps.",
      });
      const details = getDetails(result);
      expect(details.ok).toBe(true);
      const proposal = details.proposal as Record<string, unknown>;
      expect(proposal.name).toBe("deploy-api");
      expect(typeof proposal.id).toBe("string");

      const skillPath = getStringField(proposal, "skillMdPath");
      await expect(fs.stat(skillPath)).rejects.toBeTruthy();
    });
  });

  it("approve writes SKILL.md to allowed root", async () => {
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const proposed = await tool.execute("call-1", {
        action: "propose",
        name: "release-helper",
        target: "workspace",
        contents: "# Release Helper\n\nUse safe release commands.",
      });
      const proposalId = String((getDetails(proposed).proposal as Record<string, unknown>).id);
      const approved = await tool.execute("call-2", {
        action: "approve",
        proposalId,
      });
      const details = getDetails(approved);
      expect(details.ok).toBe(true);
      const skillMdPath = getStringField(details, "skillMdPath");
      const file = await fs.readFile(skillMdPath, "utf8");
      expect(file).toContain("Release Helper");
    });
  });

  it("approve refuses contents that match secret patterns", async () => {
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const proposed = await tool.execute("call-1", {
        action: "propose",
        name: "unsafe-skill",
        contents: "# Unsafe\n\nAuthorization: Bearer sk-secret-token-123456789",
      });
      const proposalId = String((getDetails(proposed).proposal as Record<string, unknown>).id);
      const approved = await tool.execute("call-2", {
        action: "approve",
        proposalId,
      });
      const details = getDetails(approved);
      expect(details.ok).toBe(false);
      expect(getStringField(details, "error")).toContain("detected sensitive content");
    });
  });

  it("approve refuses when SKILL.md is a symlink pointing outside the skill root", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const proposed = await tool.execute("call-1", {
        action: "propose",
        name: "symlink-md-target",
        contents: "# Skill\n\nBody.",
      });
      const proposalId = String((getDetails(proposed).proposal as Record<string, unknown>).id);
      const { rootPath } = resolveSkillRoot(workspaceDir, "workspace");
      const skillDir = path.join(rootPath, "symlink-md-target");
      await fs.mkdir(skillDir, { recursive: true });
      const outsideFile = path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-md-out-")),
        "target.md",
      );
      await fs.writeFile(outsideFile, "secret", "utf8");
      const skillMdPath = path.join(skillDir, "SKILL.md");
      await fs.symlink(outsideFile, skillMdPath);
      const approved = await tool.execute("call-md-symlink", {
        action: "approve",
        proposalId,
      });
      expect(getDetails(approved).ok).toBe(false);
      expect(getStringField(getDetails(approved), "error")).toContain("symlink resolution");
    });
  });

  it("approve refuses proposal when resolved path escapes root via symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const { rootPath } = resolveSkillRoot(workspaceDir, "workspace");
      await fs.mkdir(rootPath, { recursive: true });
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-escape-"));
      const linkPath = path.join(rootPath, "escape-link");
      await fs.symlink(outsideDir, linkPath, "dir");
      const malicious = {
        id: "malicious",
        name: "escape",
        targetRoot: "workspace" as const,
        skillDir: path.join(linkPath, "nested-skill"),
        skillMdPath: path.join(linkPath, "nested-skill", "SKILL.md"),
        contents: "# Escape\n",
        createdAt: Date.now(),
        createdBySessionKey: "agent:main:main",
      };
      clearProposalsForTests();
      setProposalForTests(malicious);
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const approved = await tool.execute("call-symlink", {
        action: "approve",
        proposalId: malicious.id,
      });
      expect(getDetails(approved).ok).toBe(false);
      expect(getStringField(getDetails(approved), "error")).toContain("symlink resolution");
    });
  });

  it("approve refuses proposal when path escapes root", async () => {
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const created = createProposal({
        workspaceDir,
        name: "safe-name",
        contents: "# Test",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const escaped = {
        ...created.proposal,
        skillDir: path.resolve(workspaceDir, "..", "escaped"),
        skillMdPath: path.resolve(workspaceDir, "..", "escaped", "SKILL.md"),
      };
      clearProposalsForTests();
      setProposalForTests(escaped);
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const approved = await tool.execute("call-approve", {
        action: "approve",
        proposalId: escaped.id,
      });
      expect(getDetails(approved).ok).toBe(false);
      expect(getStringField(getDetails(approved), "error")).toContain(
        "outside allowed skill roots",
      );
    });
  });

  it("delete removes a pending proposal", async () => {
    await withTempDir("openclaw-skills-manage-", async (workspaceDir) => {
      const tool = createSkillsManageTool({ workspaceDir, agentSessionKey: "agent:main:main" });
      const proposed = await tool.execute("call-1", {
        action: "propose",
        name: "cleanup-skill",
        contents: "# Cleanup",
      });
      const proposalId = String((getDetails(proposed).proposal as Record<string, unknown>).id);
      const deleted = await tool.execute("call-2", {
        action: "delete",
        proposalId,
      });
      expect(getDetails(deleted)).toMatchObject({ ok: true, deleted: true });

      const listed = await tool.execute("call-3", { action: "list" });
      const proposals = (getDetails(listed).proposals ?? []) as unknown[];
      expect(proposals.length).toBe(0);
    });
  });
});
