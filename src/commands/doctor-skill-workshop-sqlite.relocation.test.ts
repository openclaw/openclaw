import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderProposalMarkdown } from "../skills/workshop/frontmatter.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  reviseSkillProposal,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposalRecord as readStoredSkillProposalRecord,
  readSkillProposalRollback,
} from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";
import {
  createAppliedLegacyProposal,
  expectWorkshopMigrationConverged,
  readSkillProposalRecord,
  seedLegacyV15ProposalRows,
} from "./doctor-skill-workshop-sqlite.test-support.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-workshop-sqlite-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("doctor Skill Workshop SQLite relocation and legacy migration", () => {
  it("leaves an applied skill in place when its workspace has ambiguous owners", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-ambiguous-workspace-"),
    );
    const legacySkillDir = path.join(workspaceDir, "skills", "ambiguous-workshop");
    const skillContent =
      "---\nname: ambiguous-workshop\ndescription: Ambiguous procedure\n---\n\n# Ambiguous\n";
    const record = createAppliedLegacyProposal({
      id: "ambiguous-workshop-20260901-1234567890",
      title: "Create Ambiguous Workshop",
      description: "Ambiguous procedure",
      content: skillContent,
      target: { skillKey: "ambiguous-workshop", skillDir: legacySkillDir },
    });
    await fs.mkdir(legacySkillDir, { recursive: true });
    await fs.writeFile(record.target.skillFile, skillContent, "utf8");
    await seedLegacyV15ProposalRows(testState.env, [
      { record, workspaceDir, claimReleasedTime: null, ownerAgentId: null },
    ]);

    const config = {
      agents: {
        entries: {
          alpha: { workspace: workspaceDir },
          beta: { workspace: workspaceDir },
        },
      },
    };
    const result = await migrateLegacySkillWorkshopProposals({
      config,
      env: testState.env,
    });

    expect(result.changes.join("\n")).toContain("marked 1 stale");
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(skillContent);
    await expect(
      fs.access(resolveWorkshopSkillsDir(config, "alpha", testState.env)),
    ).rejects.toThrow();
    expect(
      openOpenClawStateDatabase({ env: testState.env })
        .db.prepare(
          "SELECT status, status_reason FROM skill_workshop_proposals WHERE proposal_id = ?",
        )
        .get(record.id),
    ).toMatchObject({
      status: "stale",
      status_reason: expect.stringContaining("could not identify one owning agent"),
    });
  });

  it("leaves an applied skill in place when its row owner is not configured", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-retired-owner-workspace-"),
    );
    const legacySkillDir = path.join(workspaceDir, "skills", "retired-owner-workshop");
    const skillContent =
      "---\nname: retired-owner-workshop\ndescription: Retired owner procedure\n---\n\n# Retired\n";
    const record = createAppliedLegacyProposal({
      id: "retired-owner-workshop-20260901-1234567890",
      title: "Create Retired Owner Workshop",
      description: "Retired owner procedure",
      content: skillContent,
      target: { skillKey: "retired-owner-workshop", skillDir: legacySkillDir },
    });
    await fs.mkdir(legacySkillDir, { recursive: true });
    await fs.writeFile(record.target.skillFile, skillContent, "utf8");
    await seedLegacyV15ProposalRows(testState.env, [
      { record, workspaceDir, claimReleasedTime: null, ownerAgentId: "retired" },
    ]);

    const config = {
      agents: { entries: { main: { workspace: workspaceDir } } },
    };
    await expect(
      inspectLegacySkillWorkshopMigration({ config, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 1,
      externalProposalDetails: expect.any(Array),
      externalProposalCountsByAgent: { retired: 1 },
      legacyBackupRootCount: 0,
      preservedLegacyBackupRootCount: 0,
    });
    const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    expect(result.changes.join("\n")).toContain("marked 1 stale");
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(skillContent);
    await expect(fs.access(legacySkillDir)).resolves.toBeUndefined();
    await expect(
      fs.access(resolveWorkshopSkillsDir(config, "retired", testState.env)),
    ).rejects.toThrow();
    await expect(readSkillProposalRecord(record.id, { env: testState.env })).resolves.toMatchObject(
      {
        status: "stale",
        statusReason: expect.stringContaining("retired"),
        target: {
          skillDir: legacySkillDir,
          skillFile: record.target.skillFile,
        },
      },
    );
  });

  it("persists each relocation before continuing after a later move fails", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-relocation-failure-workspace-"),
    );
    const records = ["first-relocation", "second-relocation"].map((name) => {
      const skillDir = path.join(workspaceDir, "skills", name);
      const content = `---\nname: ${name}\ndescription: ${name} procedure\n---\n\n# ${name}\n`;
      return {
        content,
        record: createAppliedLegacyProposal({
          id: `${name}-20260901-1234567890`,
          title: `Create ${name}`,
          description: `${name} procedure`,
          content,
          target: { skillKey: name, skillDir },
        }),
      };
    });
    for (const { record, content } of records) {
      await fs.mkdir(record.target.skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content, "utf8");
    }

    await seedLegacyV15ProposalRows(
      testState.env,
      records.map((record) => ({ record: record.record, workspaceDir, claimReleasedTime: null })),
    );

    const workshopRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    const secondSource = records[1]!.record.target.skillDir;
    const secondDestination = path.join(workshopRoot, "second-relocation");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (
        path.resolve(String(source)) === path.resolve(secondSource) &&
        path.resolve(String(destination)) === path.resolve(secondDestination)
      ) {
        throw new Error("injected relocation failure");
      }
      return originalRename(source, destination);
    });
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
      ).rejects.toThrow("injected relocation failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect(
      (await readSkillProposalRecord(records[0]!.record.id, { env: testState.env }))?.target,
    ).toMatchObject({
      skillDir: path.join(workshopRoot, "first-relocation"),
      skillFile: path.join(workshopRoot, "first-relocation", "SKILL.md"),
      source: "openclaw-workshop",
    });

    const repaired = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(repaired.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 0 stale",
    );
    for (const { record } of records) {
      const targetDir = path.join(workshopRoot, path.basename(record.target.skillDir));
      await expect(fs.access(path.join(targetDir, "SKILL.md"))).resolves.toBeUndefined();
      await expect(
        readSkillProposalRecord(record.id, { env: testState.env }),
      ).resolves.toMatchObject({
        target: {
          skillDir: targetDir,
          skillFile: path.join(targetDir, "SKILL.md"),
          source: "openclaw-workshop",
        },
      });
    }
    await expectWorkshopMigrationConverged({ env: testState.env });
  });

  it("keeps a released legacy skill user-owned through the v16 migration and Doctor repair", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-released-workspace-"),
    );
    const legacyRecord = (name: string, content: string) =>
      createAppliedLegacyProposal({
        id: `${name}-20260901-1234567890`,
        title: `Create ${name}`,
        description: `${name} procedure`,
        content,
        target: { skillKey: name, skillDir: path.join(workspaceDir, "skills", name) },
      });
    // v15 collection review dropped this skill and released its claim; the operator
    // then recreated the path by hand, so it is theirs.
    const recreatedContent =
      "---\nname: released-skill\ndescription: Handwritten again\n---\n\n# Mine\n";
    const released = legacyRecord("released-skill", "---\nname: released-skill\n---\n");
    const activeContent =
      "---\nname: active-skill\ndescription: Still Workshop-owned\n---\n\n# Active\n";
    const active = legacyRecord("active-skill", activeContent);
    for (const [record, content] of [
      [released, recreatedContent],
      [active, activeContent],
    ] as const) {
      await fs.mkdir(record.target.skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content, "utf8");
    }
    // Build the shipped v15 row shape, then let the store upgrade it on next open.
    await seedLegacyV15ProposalRows(testState.env, [
      { record: released, workspaceDir, claimReleasedTime: 1_756_684_800_000 },
      { record: active, workspaceDir, claimReleasedTime: null },
    ]);

    const repaired = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(repaired.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 0 stale",
    );
    await expect(fs.readFile(released.target.skillFile, "utf8")).resolves.toBe(recreatedContent);
    await expect(
      fs.access(path.join(resolveWorkshopSkillsDir({}, "main", testState.env), "released-skill")),
    ).rejects.toThrow();
    await expect(
      readSkillProposalRecord(released.id, { env: testState.env }),
    ).resolves.toMatchObject({
      status: "stale",
      statusReason: expect.stringContaining("stays user-owned"),
      target: { skillDir: released.target.skillDir },
    });
    await expect(fs.access(active.target.skillDir)).rejects.toThrow();
    await expect(
      fs.readFile(
        path.join(resolveWorkshopSkillsDir({}, "main", testState.env), "active-skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe(activeContent);
    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 0,
      externalProposalCountsByAgent: {},
      legacyBackupRootCount: 0,
      preservedLegacyBackupRootCount: 0,
    });
    await expectWorkshopMigrationConverged({ env: testState.env });
  });

  it("imports verified sidecars, preserves review artifacts, and removes legacy JSON", async () => {
    const oldWorkspace = await tempDirs.make("openclaw-workshop-old-workspace-");
    const currentWorkspace = await tempDirs.make("openclaw-workshop-current-workspace-");
    const proposalId = "legacy-workshop-20260727-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(oldWorkspace, "skills", "legacy-workshop");
    const now = "2026-07-27T00:00:00.000Z";
    const content = renderProposalMarkdown({
      name: "legacy-workshop",
      description: "Migrate the legacy proposal store",
      content: "# Legacy Workshop\n\nKeep this review artifact.\n",
      date: now,
    });
    const record: SkillProposalRecord = {
      ...createAppliedLegacyProposal({
        id: proposalId,
        title: "Create Legacy Workshop",
        description: "Migrate the legacy proposal store",
        createdAt: now,
        createdBy: "cli",
        content,
        target: {
          skillName: "Legacy Workshop",
          skillKey: "legacy-workshop",
          skillDir: targetDir,
        },
      }),
      status: "pending",
      appliedAt: undefined,
      origin: {
        sessionKey: "agent:main:legacy-workshop",
        runId: "legacy-run",
        messageId: "legacy-message",
      },
      originRunIds: ["legacy-run", "revision-run"],
      originRunMutationCounts: { "legacy-run": 1, "revision-run": 2 },
    };
    const previousSupportContent = "\n".repeat(256 * 1024);
    const rollback: SkillProposalRollback = {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
      proposalId,
      writtenAt: now,
      targetSkillFile: record.target.skillFile,
      action: "create",
      supportFiles: Array.from({ length: 64 }, (_, index) => ({
        path: `references/large-${index}.md`,
        existed: true,
        previousContent: previousSupportContent,
        previousContentHash: hashSkillProposalContent(previousSupportContent),
      })),
    };
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");
    await fs.writeFile(path.join(proposalDir, "PROPOSAL.md"), content, "utf8");
    await fs.writeFile(path.join(proposalDir, "rollback.json"), JSON.stringify(rollback), "utf8");
    await fs.writeFile(
      path.join(proposalDir, "references", "proof.md"),
      "# Preserved support file\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(testState.stateDir, "skill-workshop", "proposals.json"),
      "{}",
      "utf8",
    );

    await expect(listSkillProposals({ config: {}, agentId: "main" })).resolves.toMatchObject({
      proposals: [],
    });
    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { workspace: oldWorkspace },
            other: { workspace: currentWorkspace },
          },
        },
      },
    });
    // Import preserves the large receipt, but its support set does not match
    // this proposal. Recovery must remain bound to the original target.
    expect(result).toMatchObject({
      detected: 1,
      migrated: 1,
      warnings: [expect.stringContaining(proposalId)],
    });

    const listed = await listSkillProposals({ config: {}, agentId: "main" });
    expect(listed.proposals).toEqual([expect.objectContaining({ id: proposalId })]);
    await expect(
      inspectSkillProposal(proposalId, { config: {}, agentId: "main" }),
    ).resolves.toMatchObject({
      record: {
        originRunIds: ["legacy-run", "revision-run"],
        originRunMutationCounts: { "legacy-run": 1, "revision-run": 2 },
        target: {
          skillDir: targetDir,
        },
      },
    });
    await expect(readSkillProposalRollback(proposalId)).resolves.toMatchObject(rollback);
    await expect(fs.readFile(path.join(proposalDir, "PROPOSAL.md"), "utf8")).resolves.toBe(content);
    await expect(
      fs.readFile(path.join(proposalDir, "references", "proof.md"), "utf8"),
    ).resolves.toContain("Preserved support file");
    await expect(fs.access(path.join(proposalDir, "proposal.json"))).rejects.toThrow();
    await expect(fs.access(path.join(proposalDir, "rollback.json"))).rejects.toThrow();
    await expect(
      fs.access(path.join(testState.stateDir, "skill-workshop", "proposals.json")),
    ).rejects.toThrow();
    expect(openOpenClawStateDatabase().db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });

    const ambiguousId = "ambiguous-workshop-20260727-1234567890";
    const ambiguousDir = path.join(testState.stateDir, "skill-workshop", "proposals", ambiguousId);
    const ambiguousRecord: SkillProposalRecord = {
      ...record,
      id: ambiguousId,
      origin: { runId: "ambiguous-run" },
      originRunIds: ["ambiguous-run"],
      originRunMutationCounts: { "ambiguous-run": 1 },
      target: {
        ...record.target,
        skillDir: path.join(oldWorkspace, "skills", "ambiguous-workshop"),
        skillFile: path.join(oldWorkspace, "skills", "ambiguous-workshop", "SKILL.md"),
      },
    };
    await fs.mkdir(ambiguousDir, { recursive: true });
    await fs.writeFile(
      path.join(ambiguousDir, "proposal.json"),
      JSON.stringify(ambiguousRecord),
      "utf8",
    );
    await fs.writeFile(path.join(ambiguousDir, "PROPOSAL.md"), content, "utf8");
    const secondWorkspace = await tempDirs.make("openclaw-workshop-second-agent-");
    const ambiguous = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { workspace: currentWorkspace },
            other: { workspace: secondWorkspace },
          },
        },
      },
    });
    expect(ambiguous).toMatchObject({ migrated: 0 });
    expect(ambiguous.warnings).toEqual([
      expect.stringContaining("owning agent could not be inferred"),
      expect.stringContaining(proposalId),
    ]);
    await expect(fs.access(path.join(ambiguousDir, "proposal.json"))).resolves.toBeUndefined();
  });
});

describe("doctor Skill Workshop SQLite migration", () => {
  it("stales an outside pending update once and converges", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-stale-update-workspace-"),
    );
    const proposalId = "stale-workshop-20260901-1234567890";
    const skillDir = path.join(workspaceDir, "skills", "stale-workshop");
    const skillFile = path.join(skillDir, "SKILL.md");
    const skillContent =
      "---\nname: stale-workshop\ndescription: Stale procedure\n---\n\n# Stale\n";
    const now = "2026-09-01T00:00:00.000Z";
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "update",
      status: "pending",
      title: "Update Stale Workshop",
      description: "Stale procedure",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(skillContent),
      target: {
        skillName: "stale-workshop",
        skillKey: "stale-workshop",
        skillDir,
        skillFile,
        source: "openclaw-workspace",
        currentContentHash: hashSkillProposalContent(skillContent),
      },
      scan: {
        state: "clean",
        scannedAt: now,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    };
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, skillContent, "utf8");
    await testState.writeText(
      `skill-workshop/proposals/${record.id}/${record.draftFile}`,
      skillContent,
    );
    await importLegacySkillProposal({
      record,
      ownerAgentId: "main",
      store: { env: testState.env },
    });

    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 1,
      externalProposalDetails: [expect.stringContaining(proposalId)],
      externalProposalCountsByAgent: { main: 1 },
      legacyBackupRootCount: 0,
      preservedLegacyBackupRootCount: 0,
    });
    const first = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(first.changes.join("\n")).toContain("marked 1 stale");
    await expect(
      readStoredSkillProposalRecord(
        proposalId,
        { config: {}, env: testState.env },
        {},
        { config: {} },
      ),
    ).resolves.toMatchObject({
      status: "stale",
      statusReason: "Skill Workshop no longer edits skills outside its own directory.",
    });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(skillContent);
    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 0,
      externalProposalCountsByAgent: {},
      legacyBackupRootCount: 0,
      preservedLegacyBackupRootCount: 0,
    });
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 1, migrated: 0 });
  });

  it("restores a shipped partial apply after migration and allows retry", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-partial-upgrade-");
    const proposalId = "partial-workshop-20260729-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(workspaceDir, "skills", "partial-workshop");
    const targetSupportFile = path.join(targetDir, "references", "proof.md");
    const now = "2026-07-29T00:00:00.000Z";
    const supportContent = "Shipped partial support.\n";
    const content = renderProposalMarkdown({
      name: "partial-workshop",
      description: "Recover a shipped interrupted apply",
      content: "# Partial Workshop\n\nOriginal shipped proposal.\n",
      date: now,
    });
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "pending",
      title: "Create Partial Workshop",
      description: "Recover a shipped interrupted apply",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      origin: { agentId: "main", runId: "partial-upgrade-run" },
      originRunIds: ["partial-upgrade-run"],
      originRunMutationCounts: { "partial-upgrade-run": 1 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(content),
      supportFiles: [
        {
          path: "references/proof.md",
          sizeBytes: Buffer.byteLength(supportContent, "utf8"),
          hash: hashSkillProposalContent(supportContent),
        },
      ],
      target: {
        skillName: "Partial Workshop",
        skillKey: "partial-workshop",
        skillDir: targetDir,
        skillFile: path.join(targetDir, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: {
        state: "clean",
        scannedAt: now,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    };
    const rollback: SkillProposalRollback = {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
      proposalId,
      writtenAt: now,
      targetSkillFile: record.target.skillFile,
      action: "create",
      supportFiles: [{ path: "references/proof.md", existed: false }],
    };
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.mkdir(path.dirname(targetSupportFile), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");
    await fs.writeFile(path.join(proposalDir, "PROPOSAL.md"), content, "utf8");
    await fs.writeFile(path.join(proposalDir, "references", "proof.md"), supportContent, "utf8");
    await fs.writeFile(path.join(proposalDir, "rollback.json"), JSON.stringify(rollback), "utf8");
    await fs.writeFile(targetSupportFile, supportContent, "utf8");
    await expect(fs.readFile(targetSupportFile, "utf8")).resolves.toBe(supportContent);

    await expect(
      migrateLegacySkillWorkshopProposals({
        config: {
          agents: {
            entries: {
              main: { workspace: workspaceDir },
            },
          },
        },
      }),
    ).resolves.toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    await expect(readSkillProposalRollback(proposalId)).resolves.toBeNull();

    await expect(listSkillProposals({ config: {}, agentId: "main" })).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposalId, status: "pending" })],
    });
    await expect(fs.access(targetSupportFile)).rejects.toMatchObject({ code: "ENOENT" });

    const revised = await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      config: {},
      proposalId,
      content: "# Partial Workshop\n\nRevised after recovery.\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, agentId: "main", config: {}, proposalId }),
    ).resolves.toMatchObject({ record: { id: proposalId, status: "applied" } });
    await expect(fs.readFile(revised.record.target.skillFile, "utf8")).resolves.toContain(
      "Revised after recovery.",
    );
    await expect(fs.access(targetSupportFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(revised.record.target.skillDir, "references", "proof.md"), "utf8"),
    ).resolves.toBe(supportContent);
  });
});
