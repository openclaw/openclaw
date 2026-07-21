import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "./runtime/refresh-state.js";
import { skillsWriteService } from "./write-service.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  resetSkillsRefreshStateForTest();
  await tempDirs.cleanup();
});

function skillContent(name: string, body = "# Example\n"): string {
  return `---\nname: ${name}\ndescription: Test ${name}\n---\n\n${body}`;
}

describe("skills write service", () => {
  it("owns proposal creation and application", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-write-service-workspace-");
    const proposalInput = {
      kind: "create" as const,
      workspaceDir,
      name: "service-proposal",
      description: "Create through the write service",
      content: "# Service Proposal\n",
    };
    const proposalPromise = skillsWriteService.propose(proposalInput);
    proposalInput.content = "# Mutated Proposal\n";
    const proposal = await proposalPromise;

    expect(proposal.content).toContain("# Service Proposal");
    expect(proposal.content).not.toContain("# Mutated Proposal");

    const applyInput = { workspaceDir, proposalId: proposal.record.id };
    const applyPromise = skillsWriteService.applyProposal(applyInput);
    applyInput.proposalId = "mutated-proposal-id";
    const applied = await applyPromise;

    expect(applied.record.status).toBe("applied");
    await expect(fs.readFile(applied.targetSkillFile, "utf8")).resolves.toContain(
      'name: "service-proposal"',
    );
  });

  it("owns prepared full-bundle installation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-write-service-workspace-");
    const extractedRoot = await tempDirs.make("openclaw-skills-write-service-bundle-");
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      skillContent("bundle-skill", "# Installed bundle\n"),
      "utf8",
    );
    await fs.mkdir(path.join(extractedRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "scripts", "helper.sh"), "echo bundle\n", "utf8");

    await expect(
      skillsWriteService.installBundle({
        kind: "directory",
        workspaceDir,
        slug: "bundle-skill",
        extractedRoot,
        mode: "install",
      }),
    ).resolves.toEqual({
      ok: true,
      targetDir: path.join(workspaceDir, "skills", "bundle-skill"),
    });
    await expect(
      fs.readFile(
        path.join(workspaceDir, "skills", "bundle-skill", "scripts", "helper.sh"),
        "utf8",
      ),
    ).resolves.toBe("echo bundle\n");
  });

  it("owns explicit snapshot refresh", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skills-write-service-refresh-");
    const versionBefore = getSkillsSnapshotVersion(workspaceDir);

    expect(skillsWriteService.refreshSnapshot(workspaceDir)).toBeGreaterThan(versionBefore);
  });
});
