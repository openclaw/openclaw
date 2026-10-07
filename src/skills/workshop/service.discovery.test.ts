import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readInstalledSkill, searchInstalledSkills } from "../../agents/installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "../../agents/installed-skill-runtime.js";
import { migrateLegacyConfig } from "../../commands/doctor/shared/legacy-config-migrate.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../runtime/refresh-state.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { applySkillProposal, proposeCreateSkill } from "./service.js";

let root = "";
let stateDir = "";
let testEnv: NodeJS.ProcessEnv;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeSkillsWatchers();
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(testEnv));
    resetSkillsRefreshStateForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeAll(() => {
  root = dirs.make("openclaw-workshop-discovery-");
  stateDir = path.join(root, "state");
});
beforeEach(() => {
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_BUNDLED_SKILLS_DIR: path.join(root, "bundled"),
  })) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  testEnv = { ...process.env };
});

describe("Workshop apply through canonical discovery", () => {
  it("discovers an applied skill on the next eligible turn without an agent name allowlist", async () => {
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir);
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "disabled"),
      name: "disabled",
      description: "Explicitly disabled fixture",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "needs-env"),
      name: "needs-env",
      description: "Missing prerequisite fixture",
      metadata: '{"openclaw":{"requires":{"env":["OPENCLAW_TEST_NEVER_SET_SKILL_REQUIREMENT"]}}}',
    });
    vi.stubEnv("OPENCLAW_TEST_NEVER_SET_SKILL_REQUIREMENT", undefined);
    const raw = {
      plugins: { enabled: false },
      agents: { entries: { main: { skills: ["existing-skill"] }, other: { skills: [] } } },
      skills: { entries: { disabled: { enabled: false } } },
    };
    const migration = migrateLegacyConfig(raw, {
      sourceConfigBeforeMigrations: raw,
      pluginContracts: false,
    });
    const config = migration.config;
    if (!config) {
      throw new Error("Expected Doctor to retire the configured lists");
    }
    expect(migration.warnings).toHaveLength(2);
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", path.join(stateDir, "empty-bundled"));
    const params = { workspaceDir, config, agentId: "main" };
    const { snapshot: before } = await resolveReusableWorkspaceSkillSnapshot(params);
    const proposal = await proposeCreateSkill({
      workspaceDir,
      env: testEnv,
      config,
      agentId: "main",
      name: "new-workshop-skill",
      description: "A newly applied reusable workflow",
      content: "# Newly Applied Workflow\nUse this workflow for the fixture task.\n",
    });
    const applied = await applySkillProposal({
      workspaceDir,
      env: testEnv,
      config,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    expect(applied.record.status).toBe("applied");
    expect(applied.targetSkillFile).toBe(
      path.join(
        stateDir,
        "agents",
        "main",
        "agent",
        "workshop-skills",
        "new-workshop-skill",
        "SKILL.md",
      ),
    );
    expect(await fs.readFile(applied.targetSkillFile, "utf8")).toContain("Use this workflow");
    const versionAfterApply = getSkillsSnapshotVersion(workspaceDir);
    const { snapshot: next, shouldRefresh } = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: before,
    });
    expect(shouldRefresh).toBe(true);
    expect(next.version).toBeGreaterThan(before.version ?? 0);
    expect(next.version).toBeGreaterThanOrEqual(versionAfterApply);
    expect(next.skills.map((skill) => skill.name)).toContain("new-workshop-skill");
    expect(next.prompt).toContain("A newly applied reusable workflow");
    expect(next.skillFilter).toBeUndefined();
    const legacyEmptySnapshot = {
      ...next,
      prompt: "Legacy empty selection",
      skills: [],
      resolvedSkills: [],
      discoverySkills: [],
      skillFilter: [],
    };
    const retainedBytes = JSON.stringify(legacyEmptySnapshot);
    const refreshed = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: legacyEmptySnapshot,
    });
    expect(refreshed.shouldRefresh).toBe(true);
    expect(refreshed.snapshot.skills.map((skill) => skill.name)).toContain("new-workshop-skill");
    expect(JSON.stringify(legacyEmptySnapshot)).toBe(retainedBytes);
    expect(next.skills.map((skill) => skill.name)).not.toContain("disabled");
    expect(next.skills.map((skill) => skill.name)).not.toContain("needs-env");
    const catalog = prepareInstalledSkillCatalog({ snapshot: next, workspaceDir });
    expect(
      (await searchInstalledSkills(catalog, "new-workshop-skill")).skills.map(
        (skill) => skill.name,
      ),
    ).toContain("new-workshop-skill");
    expect(await readInstalledSkill(catalog, "new-workshop-skill")).toContain(
      "Use this workflow for the fixture task",
    );
    expect(
      buildWorkspaceSkillCommandSpecs(workspaceDir, { config, agentId: "main" }).map(
        (command) => command.skillName,
      ),
    ).toContain("new-workshop-skill");
    expect(
      buildWorkspaceSkillStatus(workspaceDir, { config, agentId: "main" }).skills.find(
        (skill) => skill.name === "new-workshop-skill",
      ),
    ).toMatchObject({ eligible: true, modelVisible: true, commandVisible: true });
    expect(
      (await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: next })).snapshot,
    ).toBe(next);
    expect(
      (
        await resolveReusableWorkspaceSkillSnapshot({ ...params, agentId: "other" })
      ).snapshot.skills.map((skill) => skill.name),
    ).not.toContain("new-workshop-skill");
    const { snapshot: focused } = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      skillFilter: [],
      skillOverrides: { "new-workshop-skill": true, disabled: true, "needs-env": true },
    });
    expect(focused.skills.map((skill) => skill.name)).toEqual(["new-workshop-skill"]);
    const { snapshot: deselected } = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      skillOverrides: { "new-workshop-skill": false },
    });
    expect(deselected.skills.map((skill) => skill.name)).not.toContain("new-workshop-skill");
  });
});
