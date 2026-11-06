import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { prepareRuntimeSkillEntries } from "../../agents/embedded-agent-runner/skills-prompt.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync, createPathResolutionEnv } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { refreshSkillsDiscovery } from "../runtime/refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-snapshot-suite-");
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
let tempHome: TempHomeEnv | null = null;
let skillsHomeEnv: SkillsHomeEnvSnapshot | null = null;

beforeAll(async () => {
  await fixtureSuite.setup();
  tempHome = await createTempHomeEnv("openclaw-skills-snapshot-home-");
  skillsHomeEnv = setMockSkillsHomeEnv(tempHome.home);
});

afterAll(async () => {
  if (skillsHomeEnv) {
    await restoreMockSkillsHomeEnv(skillsHomeEnv);
    skillsHomeEnv = null;
  }
  if (tempHome) {
    await tempHome.restore();
    tempHome = null;
  }
  await fixtureSuite.cleanup();
});

async function withWorkspaceHome<T>(workspaceDir: string, cb: () => Promise<T>): Promise<T> {
  return withEnvAsync(createPathResolutionEnv(workspaceDir, { PATH: "" }), cb);
}

function buildSnapshot(workspaceDir: string, options?: Parameters<typeof buildSkillSnapshot>[1]) {
  return withWorkspaceHome(workspaceDir, () =>
    buildSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      ...options,
      config: { ...options?.config, plugins: { enabled: false } },
    }),
  );
}

const CUSTODIAN_SKILL_NAMES = [
  "add-model-provider",
  "cloud-image-bake",
  "configure-channel",
  "diagnose-gateway",
] as const;

const write = (dir: string, name: string, description: string, body?: string) =>
  writeSkill({ dir: path.join(dir, name), name, description, body });
const resolveSnapshot = (params: Parameters<typeof resolveReusableWorkspaceSkillSnapshot>[0]) =>
  withWorkspaceHome(params.workspaceDir, () => resolveReusableWorkspaceSkillSnapshot(params));
const resolveRuntime = (params: Parameters<typeof prepareRuntimeSkillEntries>[0]) =>
  withWorkspaceHome(params.skillsAnchorWorkspace, () => prepareRuntimeSkillEntries(params));

async function createMultiRootFixture() {
  const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-workspace");
  const executionWorkspaceDir = await fixtureSuite.createCaseDir("execution-workspace");
  for (const [workspaceDir, name, description] of [
    [agentWorkspaceDir, "middle", "Agent middle"],
    [agentWorkspaceDir, "shared", "Agent shared"],
    [executionWorkspaceDir, "aardvark", "Execution aardvark"],
    [executionWorkspaceDir, "shared", "Execution shared"],
    [executionWorkspaceDir, "zulu", "Execution zulu"],
  ] as const) {
    await write(path.join(workspaceDir, "skills"), name, description);
  }
  for (const name of ["aardvark", "project-only", "shared"]) {
    await write(
      path.join(executionWorkspaceDir, ".agents", "skills"),
      name,
      `Project ${name}`,
      `# Project ${name} instructions\n`,
    );
  }
  const skillFilter = ["aardvark", "middle", "project-only", "shared", "zulu"];
  const { snapshot } = await resolveSnapshot({
    workspaceDir: agentWorkspaceDir,
    executionWorkspaceDir,
    config: { plugins: { enabled: false } },
    skillFilter,
    watch: false,
    snapshotVersion: 1,
  });
  return { agentWorkspaceDir, executionWorkspaceDir, skillFilter, snapshot };
}

describe("buildSkillSnapshot", () => {
  it("keeps custodian skills absent from every non-custodian discovery surface", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("custodian-gate");
    for (const name of CUSTODIAN_SKILL_NAMES) {
      await write(path.join(workspaceDir, "custodian-skills"), name, `Custodian ${name}`);
    }
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, writer: {} },
      },
    };

    const snapshotFor = (agentId: string) => buildSnapshot(workspaceDir, { config, agentId });
    const statusFor = (agentId: string) =>
      buildWorkspaceSkillStatus(workspaceDir, {
        config,
        agentId,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
      });
    const firstCustodianSnapshot = await snapshotFor("ops");
    const secondCustodianSnapshot = await snapshotFor("ops");
    const writerSnapshot = await snapshotFor("writer");
    const custodianStatus = statusFor("ops");
    const writerStatus = statusFor("writer");

    expect(firstCustodianSnapshot.skills.map((skill) => skill.name)).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(firstCustodianSnapshot.resolvedSkills?.map((skill) => skill.source)).toEqual(
      CUSTODIAN_SKILL_NAMES.map(() => "openclaw-custodian"),
    );
    expect(secondCustodianSnapshot.skills).toEqual(firstCustodianSnapshot.skills);
    expect(secondCustodianSnapshot.prompt).toBe(firstCustodianSnapshot.prompt);
    expect(writerSnapshot.skills).toEqual([]);
    expect(writerSnapshot.prompt).toBe("");
    expect(
      custodianStatus.skills
        .filter((skill) => skill.source === "openclaw-custodian")
        .map((skill) => skill.name),
    ).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(writerStatus.skills.filter((skill) => skill.source === "openclaw-custodian")).toEqual(
      [],
    );
  });

  it.each([false, true])(
    "keeps snapshot and cold fallback skills readable (stale=%s)",
    async (stale) => {
      const { agentWorkspaceDir, executionWorkspaceDir, snapshot } = await createMultiRootFixture();
      const coldSnapshot = { ...snapshot, ...(stale ? { promptFormatVersion: 0 } : {}) };
      delete coldSnapshot.resolvedSkills;
      const fallback = await resolveRuntime({
        skillsAnchorWorkspace: agentWorkspaceDir,
        config: { plugins: { enabled: false } },
        skillsSnapshot: coldSnapshot,
        executionWorkspaceDir,
      });

      expect(fallback.skillEntries.map((entry) => entry.skill.name)).toEqual(
        snapshot.skills.map((skill) => skill.name),
      );
      expect(fallback.skillEntries.map((entry) => entry.skill.filePath)).toEqual(
        snapshot.resolvedSkills?.map((skill) => skill.filePath),
      );
      const codeModeSkills = resolveCodeModeSkills({
        skillsPrompt: snapshot.prompt,
        candidates: fallback.skillEntries.map((entry) => entry.skill),
      });
      const projectSkill = codeModeSkills.find((skill) => skill.name === "project-only");
      expect(projectSkill).toBeDefined();
      expect(await readCodeModeSkill(projectSkill!)).toContain(
        "# Project project-only instructions",
      );
    },
  );

  it.each([
    { split: false, override: false },
    { split: true, override: true },
  ])(
    "honors session skill policy before agent filtering (split=$split, override=$override)",
    async ({ split, override }) => {
      const workspaceDir = await fixtureSuite.createCaseDir("session-policy-agent");
      const executionWorkspaceDir = split
        ? await fixtureSuite.createCaseDir("session-policy-execution")
        : workspaceDir;
      await write(
        path.join(executionWorkspaceDir, ".agents", "skills"),
        "session-enabled",
        "Enabled by the session",
      );
      const { snapshot } = await resolveSnapshot({
        workspaceDir,
        executionWorkspaceDir,
        agentId: "main",
        config: {
          plugins: { enabled: false },
          agents: { defaults: { skills: [] } },
        },
        ...(override
          ? { skillOverrides: { "session-enabled": true } }
          : { skillFilter: ["session-enabled"] }),
        watch: false,
      });
      expect(snapshot.skills.map((skill) => skill.name)).toEqual(["session-enabled"]);
      expect(snapshot.prompt).toContain("Enabled by the session");
    },
  );

  it.each([false, true])(
    "confines sandbox rebuilds to materialized skills (hydrated=%s)",
    async (hydrated) => {
      const { executionWorkspaceDir, snapshot } = await createMultiRootFixture();
      const workspaceDir = await fixtureSuite.createCaseDir("sandbox-materialized");
      const skillDir = path.join(workspaceDir, "skills", "middle");
      await writeSkill({ dir: skillDir, name: "middle", description: "Materialized instructions" });
      const skillsSnapshot = { ...snapshot };
      if (!hydrated) {
        delete skillsSnapshot.resolvedSkills;
      }
      const runtime = await resolveRuntime({
        skillsAnchorWorkspace: workspaceDir,
        executionWorkspaceDir,
        config: { plugins: { enabled: false } },
        skillsSnapshot,
        sandbox: { enabled: true, skillsWorkspaceDir: workspaceDir },
      });
      const entries = await runtime.loadSkillEntries();
      expect(entries.map((entry) => entry.skill.name)).toEqual(["middle"]);
      expect(entries[0]?.skill).toMatchObject({
        filePath: path.join(skillDir, "SKILL.md"),
        description: "Materialized instructions",
      });
    },
  );

  it("invalidates execution project skills without escaping the selected workspace", async () => {
    const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-root");
    const repo = await fixtureSuite.createCaseDir("repository");
    const executionWorkspaceDir = path.join(repo, "packages", "app");
    const skillDir = path.join(executionWorkspaceDir, ".agents", "skills", "project-only");
    await write(path.join(repo, ".agents", "skills"), "ancestor", "Not selected");
    await writeSkill({ dir: skillDir, name: "project-only", description: "Original instructions" });
    await fs.symlink(
      path.join(repo, ".agents", "skills", "ancestor"),
      path.join(executionWorkspaceDir, ".agents", "skills", "escape"),
      directorySymlinkType,
    );
    const params = {
      workspaceDir: agentWorkspaceDir,
      executionWorkspaceDir,
      config: { plugins: { enabled: false } },
      skillFilter: ["ancestor", "project-only"],
      watch: false,
    };
    const first = await resolveSnapshot(params);
    expect(first.snapshot.skills.map((skill) => skill.name)).toEqual(["project-only"]);
    await writeSkill({ dir: skillDir, name: "project-only", description: "Updated instructions" });
    await refreshSkillsDiscovery({ workspaceDir: agentWorkspaceDir });
    const next = await resolveSnapshot({ ...params, existingSnapshot: first.snapshot });
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.prompt).toContain("Updated instructions");
    expect(next.snapshot.resolvedSkills?.[0]?.filePath).toBe(path.join(skillDir, "SKILL.md"));
    const sandbox = await resolveRuntime({
      skillsAnchorWorkspace: agentWorkspaceDir,
      executionWorkspaceDir,
      config: { plugins: { enabled: false } },
      sandbox: { enabled: true },
    });
    expect(sandbox.skillEntries).toEqual([]);
  });

  it("keeps symlinked compatibility skills out of isolated session snapshots", async () => {
    if (!tempHome) {
      throw new Error("temporary home is unavailable");
    }
    const home = await fs.realpath(tempHome.home);
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const compatibilitySkillsDir = path.join(home, ".claude", "skills");
    const personalSkillDir = path.join(compatibilitySkillsDir, "personal-compat");
    await write(compatibilitySkillsDir, "personal-compat", "Personal compatibility skill");
    await fs.mkdir(path.join(home, ".agents"), { recursive: true });
    await fs.symlink(
      compatibilitySkillsDir,
      path.join(home, ".agents", "skills"),
      directorySymlinkType,
    );
    const buildHomeSnapshot = async () =>
      await buildSkillSnapshot(workspaceDir, {
        config: { plugins: { enabled: false } },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });
    try {
      const defaultSnapshot = await withEnvAsync(
        { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
        buildHomeSnapshot,
      );
      expect(defaultSnapshot.skills.map((skill) => skill.name)).toContain("personal-compat");
      expect(defaultSnapshot.prompt).toContain("personal-compat");
      expect(defaultSnapshot.resolvedSkills?.[0]?.filePath).toBe(
        await fs.realpath(path.join(personalSkillDir, "SKILL.md")),
      );

      const isolatedSnapshot = await withEnvAsync(
        { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "scratch-state") },
        buildHomeSnapshot,
      );
      expect(isolatedSnapshot.skills.map((skill) => skill.name)).not.toContain("personal-compat");
      expect(isolatedSnapshot.prompt).not.toContain("personal-compat");
    } finally {
      await fs.rm(path.join(home, ".agents", "skills"), { force: true });
      await fs.rm(path.join(home, ".claude"), { recursive: true, force: true });
    }
  });
});
