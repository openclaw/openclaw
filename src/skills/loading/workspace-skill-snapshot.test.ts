import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { prepareRuntimeSkillEntries } from "../../agents/embedded-agent-runner/skills-prompt.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync, createPathResolutionEnv } from "../../test-utils/env.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { refreshSkillsDiscovery } from "../runtime/refresh.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { useLoadingFixture } from "./loading.test-support.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const fixture = useLoadingFixture("openclaw-skills-snapshot-suite-", "state");
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";
const isolatedConfig = { plugins: { enabled: false } };

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
  withWorkspaceHome(params.workspaceDir, () =>
    resolveReusableWorkspaceSkillSnapshot({ config: isolatedConfig, watch: false, ...params }),
  );
const resolveRuntime = (params: Parameters<typeof prepareRuntimeSkillEntries>[0]) =>
  withWorkspaceHome(params.skillsAnchorWorkspace, () => prepareRuntimeSkillEntries(params));

async function createMultiRootFixture() {
  const agentWorkspaceDir = await fixture.createDir("agent-workspace");
  const executionWorkspaceDir = await fixture.createDir("execution-workspace");
  await write(path.join(agentWorkspaceDir, "skills"), "middle", "Agent middle");
  await write(
    path.join(executionWorkspaceDir, ".agents", "skills"),
    "project-only",
    "Project skill",
    "# Project project-only instructions\n",
  );
  const { snapshot } = await resolveSnapshot({
    workspaceDir: agentWorkspaceDir,
    executionWorkspaceDir,
    skillFilter: ["middle", "project-only"],
    snapshotVersion: 1,
  });
  return { agentWorkspaceDir, executionWorkspaceDir, snapshot };
}

describe("buildSkillSnapshot", () => {
  it("keeps custodian skills absent from every non-custodian discovery surface", async () => {
    const workspaceDir = await fixture.createDir("custodian-gate");
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
    const writerSnapshot = await snapshotFor("writer");
    const custodianStatus = statusFor("ops");
    const writerStatus = statusFor("writer");

    expect(firstCustodianSnapshot.skills.map((skill) => skill.name)).toEqual(CUSTODIAN_SKILL_NAMES);
    expect(firstCustodianSnapshot.resolvedSkills?.map((skill) => skill.source)).toEqual(
      CUSTODIAN_SKILL_NAMES.map(() => "openclaw-custodian"),
    );
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
        config: isolatedConfig,
        skillsSnapshot: coldSnapshot,
        executionWorkspaceDir,
      });

      expect(fallback.skillEntries.map((entry) => entry.skill.name)).toEqual([
        "middle",
        "project-only",
      ]);
      expect(fallback.skillEntries.map((entry) => entry.skill.filePath)).toEqual([
        path.join(agentWorkspaceDir, "skills", "middle", "SKILL.md"),
        path.join(executionWorkspaceDir, ".agents", "skills", "project-only", "SKILL.md"),
      ]);
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
      const workspaceDir = await fixture.createDir("session-policy-agent");
      const executionWorkspaceDir = split
        ? await fixture.createDir("session-policy-execution")
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

  it("confines sandbox rebuilds to materialized skills despite hydrated host entries", async () => {
    const { executionWorkspaceDir, snapshot } = await createMultiRootFixture();
    const workspaceDir = await fixture.createDir("sandbox-materialized");
    const skillDir = path.join(workspaceDir, "skills", "middle");
    await writeSkill({ dir: skillDir, name: "middle", description: "Materialized instructions" });
    const runtime = await resolveRuntime({
      skillsAnchorWorkspace: workspaceDir,
      executionWorkspaceDir,
      config: isolatedConfig,
      skillsSnapshot: snapshot,
      sandbox: { enabled: true, skillsWorkspaceDir: workspaceDir },
    });
    const entries = await runtime.loadSkillEntries();
    expect(entries.map((entry) => entry.skill.name)).toEqual(["middle"]);
    expect(entries[0]?.skill).toMatchObject({
      filePath: path.join(skillDir, "SKILL.md"),
      description: "Materialized instructions",
    });
  });

  it("invalidates execution project skills without escaping the selected workspace", async () => {
    const agentWorkspaceDir = await fixture.createDir("agent-root");
    const repo = await fixture.createDir("repository");
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
      config: isolatedConfig,
      skillFilter: ["ancestor", "project-only"],
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
      config: isolatedConfig,
      sandbox: { enabled: true },
    });
    expect(sandbox.skillEntries).toEqual([]);
  });

  it("keeps symlinked compatibility skills out of isolated session snapshots", async () => {
    const home = await fs.realpath(fixture.home);
    const workspaceDir = await fixture.createDir("workspace");
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
