import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
} from "./service.js";
import { readSkillProposalManifest, resolveProposalDraftPath } from "./store.js";

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

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-skill-workshop-");
}

describe("skill workshop proposals", () => {
  it("creates a pending proposal under the workshop and applies it as an active workspace skill", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Weather Helper",
      description: "Check weather before planning outdoor tasks",
      content: "# Weather Helper\n\nUse the weather provider before answering.\n",
      supportFiles: [
        {
          path: "references/weather-api.md",
          content: "# Weather API\n\nUse the current weather endpoint.\n",
        },
        {
          path: "scripts/check-weather.js",
          content: "export function parseWeather(value) { return value; }\n",
        },
      ],
      createdBy: "skill-research",
      goal: "Reuse weather lookup steps",
    });

    expect(proposal.record.status).toBe("pending");
    expect(proposal.record.scan.state).toBe("clean");
    expect(proposal.record.supportFiles?.map((file) => file.path)).toEqual([
      "references/weather-api.md",
      "scripts/check-weather.js",
    ]);
    expect(proposal.record.target.skillFile).toBe(
      path.join(workspaceDir, "skills", "weather-helper", "SKILL.md"),
    );
    await expect(
      fs.readFile(resolveProposalDraftPath(proposal.record.id), "utf8"),
    ).resolves.toContain("status: proposal");

    const listed = await listSkillProposals();
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]).toMatchObject({
      id: proposal.record.id,
      status: "pending",
      skillKey: "weather-helper",
      scanState: "clean",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
    });
    expect(applied.targetSkillFile).toBe(proposal.record.target.skillFile);
    await expect(fs.readFile(applied.targetSkillFile, "utf8")).resolves.toBe(
      '---\nname: "Weather Helper"\ndescription: "Check weather before planning outdoor tasks"\n---\n\n# Weather Helper\n\nUse the weather provider before answering.\n',
    );
    await expect(
      fs.readFile(
        path.join(workspaceDir, "skills", "weather-helper", "references", "weather-api.md"),
        "utf8",
      ),
    ).resolves.toContain("Use the current weather endpoint.");
    await expect(
      fs.readFile(
        path.join(workspaceDir, "skills", "weather-helper", "scripts", "check-weather.js"),
        "utf8",
      ),
    ).resolves.toContain("parseWeather");

    const status = buildWorkspaceSkillStatus(workspaceDir);
    expect(status.skills.find((skill) => skill.name === "Weather Helper")).toMatchObject({
      name: "Weather Helper",
      source: "openclaw-workspace",
      filePath: applied.targetSkillFile,
    });
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("applied");
  });

  it("updates only writable workspace skills and marks stale proposals when the target changes", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "release-notes");
    await writeSkill({
      dir: skillDir,
      name: "release-notes",
      description: "Draft release notes",
      body: "# Release Notes\n\nOld steps.\n",
    });
    const skillFile = path.join(skillDir, "SKILL.md");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "release-notes",
      content: "# Release Notes\n\nNew steps.\n",
    });

    await fs.writeFile(
      skillFile,
      "---\nname: release-notes\ndescription: Draft release notes\n---\n\nChanged elsewhere.\n",
      "utf8",
    );

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("proposal marked stale");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("stale");
  });

  it("applies update proposals with rollback metadata", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = path.join(workspaceDir, "skills", "qa-check");
    await writeSkill({
      dir: skillDir,
      name: "qa-check",
      description: "Run QA checks",
      body: "# QA\n\nOld checklist.\n",
    });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "qa.md"), "Old support file.\n", "utf8");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "qa-check",
      content: "# QA\n\nNew checklist.\n",
      supportFiles: [
        {
          path: "references/qa.md",
          content: "New support file.\n",
        },
      ],
    });

    await applySkillProposal({ workspaceDir, proposalId: proposal.record.id });

    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "New checklist.",
    );
    const rollback = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "skill-workshop", "proposals", proposal.record.id, "rollback.json"),
        "utf8",
      ),
    ) as { previousContent?: string; supportFiles?: Array<{ previousContent?: string }> };
    expect(rollback.previousContent).toContain("Old checklist.");
    expect(rollback.supportFiles?.[0]?.previousContent).toContain("Old support file.");
    await expect(fs.readFile(path.join(skillDir, "references", "qa.md"), "utf8")).resolves.toBe(
      "New support file.\n",
    );
  });

  it("rejects and quarantines proposals without touching active skills", async () => {
    const workspaceDir = await makeWorkspace();
    const rejected = await proposeCreateSkill({
      workspaceDir,
      name: "Draft One",
      description: "Draft rejected proposal",
      content: "# Draft\n",
    });
    const quarantined = await proposeCreateSkill({
      workspaceDir,
      name: "Draft Two",
      description: "Draft quarantined proposal",
      content: "# Draft\n",
    });

    await rejectSkillProposal({
      workspaceDir,
      proposalId: rejected.record.id,
      reason: "not useful",
    });
    await quarantineSkillProposal({
      workspaceDir,
      proposalId: quarantined.record.id,
      reason: "needs review",
    });

    const manifest = await readSkillProposalManifest();
    expect(manifest.proposals.map((entry) => [entry.skillKey, entry.status])).toEqual([
      ["draft-two", "quarantined"],
      ["draft-one", "rejected"],
    ]);
    await expect(
      fs.access(path.join(workspaceDir, "skills", "draft-one", "SKILL.md")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(workspaceDir, "skills", "draft-two", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("rebuilds the listing manifest when the fast manifest is corrupt", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Manifest Repair",
      description: "Repair corrupt manifests",
      content: "# Manifest Repair\n",
    });
    await fs.writeFile(
      path.join(stateDir, "skill-workshop", "proposals.json"),
      "{not-json",
      "utf8",
    );

    const manifest = await listSkillProposals();

    expect(manifest.proposals).toHaveLength(1);
    expect(manifest.proposals[0]?.id).toBe(proposal.record.id);
  });

  it("quarantines unsafe proposals during apply", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Unsafe Skill",
      description: "Unsafe draft",
      content: "# Unsafe\n\n```ts\nimport { exec } from 'child_process';\nexec('whoami');\n```\n",
    });

    expect(proposal.record.scan.state).toBe("failed");
    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("Proposal scan failed");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("quarantined");
  });

  it("rejects unsafe support paths before creating proposal state", async () => {
    const workspaceDir = await makeWorkspace();

    await expect(
      proposeCreateSkill({
        workspaceDir,
        name: "Unsafe Support Path",
        description: "Reject traversal",
        content: "# Unsafe Support Path\n",
        supportFiles: [
          {
            path: "scripts/../references/escape.md",
            content: "bad\n",
          },
        ],
      }),
    ).rejects.toThrow("plain relative path segments");

    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
  });

  it("quarantines proposals with unsafe support file contents during apply", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Unsafe Support",
      description: "Unsafe support script",
      content: "# Unsafe Support\n",
      supportFiles: [
        {
          path: "scripts/run.js",
          content: "eval('2 + 2');\n",
        },
      ],
    });

    expect(proposal.record.scan.state).toBe("failed");
    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("Proposal scan failed");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("quarantined");
    await expect(
      fs.access(path.join(workspaceDir, "skills", "unsafe-support", "scripts", "run.js")),
    ).rejects.toThrow();
  });

  it("rejects tampered support files during apply", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Tamper Guard",
      description: "Detect changed proposal support files",
      content: "# Tamper Guard\n",
      supportFiles: [
        {
          path: "references/check.md",
          content: "Original\n",
        },
      ],
    });
    await fs.writeFile(
      path.join(
        stateDir,
        "skill-workshop",
        "proposals",
        proposal.record.id,
        "references",
        "check.md",
      ),
      "Changed\n",
      "utf8",
    );

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("changed without updating metadata");
    await expect(
      fs.access(path.join(workspaceDir, "skills", "tamper-guard", "SKILL.md")),
    ).rejects.toThrow();
  });
});
