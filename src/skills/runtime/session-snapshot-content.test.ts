import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  resetSkillsRefreshStateForTest,
  suspendSkillsSnapshotSources,
} from "./refresh-state.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

vi.mock("../loading/plugin-skills.js", () => ({ resolvePluginSkillRoots: () => [] }));
vi.mock("../loading/bundled-dir.js", () => ({ resolveBundledSkillsDir: () => undefined }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => resetSkillsRefreshStateForTest());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("content-addressed skill refresh", () => {
  it("reuses session snapshots after unchanged rebuilds and refreshes instruction-only edits", async () => {
    const workspaceDir = tempDirs.make("skills-content-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Demo", body: "Original body" });
    const params = { workspaceDir, config: {}, watch: false };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    const version = getSkillsSnapshotVersion(workspaceDir);
    const changed = vi.fn();
    const unregister = registerSkillsChangeListener(changed);
    try {
      for (const event of [
        { workspaceDir, reason: "watch" as const },
        { workspaceDir, reason: "watch-targets" as const },
        { reason: "manual" as const },
      ]) {
        bumpSkillsSnapshotVersion(event);
        const next = await resolveReusableWorkspaceSkillSnapshot({
          ...params,
          existingSnapshot: first.snapshot,
        });
        expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
        expect(next.snapshot).toBe(first.snapshot);
        expect(next.shouldRefresh).toBe(false);
      }
      expect(changed).not.toHaveBeenCalled();
      await fs.appendFile(path.join(skillDir, "SKILL.md"), "\nNew instructions\n");
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      const edited = await resolveReusableWorkspaceSkillSnapshot({
        ...params,
        existingSnapshot: first.snapshot,
      });
      expect(edited.shouldRefresh).toBe(true);
      expect(edited.snapshotVersion).toBeGreaterThan(version);
      expect(edited.snapshot.prompt).toBe(first.snapshot.prompt);
      expect(edited.snapshot.resolvedSkills?.[0]?.contentHash).not.toBe(
        first.snapshot.resolvedSkills?.[0]?.contentHash,
      );
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("refreshes changed installed skill identities even when instructions are identical", async () => {
    const workspaceDir = tempDirs.make("skills-content-identity-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Demo" });
    const originDir = path.join(skillDir, ".openclaw");
    const originFile = path.join(originDir, "source-origin.json");
    await fs.mkdir(originDir);
    await fs.writeFile(originFile, JSON.stringify({ slug: "demo-original" }));
    const params = { workspaceDir, config: {}, watch: false };
    const first = await resolveReusableWorkspaceSkillSnapshot(params);
    expect(first.snapshot.skills[0]?.skillKey).toBe("demo-original");
    await fs.writeFile(originFile, JSON.stringify({ slug: "demo-renamed" }));
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "manual" });
    const next = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.skills[0]?.skillKey).toBe("demo-renamed");
    expect(next.snapshot.resolvedSkills?.[0]?.contentHash).toBe(
      first.snapshot.resolvedSkills?.[0]?.contentHash,
    );
  });

  it("reconciles only affected execution roots and preserves unrelated discovery cache entries", async () => {
    const workspaceDir = tempDirs.make("skills-content-scopes-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const firstScope = { executionWorkspaceDir: path.join(workspaceDir, "first") };
    const secondScope = { executionWorkspaceDir: path.join(workspaceDir, "second") };
    const firstOptions = {
      executionWorkspaceDir: path.relative(process.cwd(), firstScope.executionWorkspaceDir),
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: "",
    };
    const secondOptions = { ...firstOptions, ...secondScope };
    const scopes = [firstScope, secondScope];
    for (const scope of scopes) {
      await writeSkill({
        dir: path.join(scope.executionWorkspaceDir, "skills", "demo"),
        name: "demo",
        description: "Demo",
      });
    }
    loadWorkspaceSkills(workspaceDir, firstOptions);
    const second = loadWorkspaceSkills(workspaceDir, secondOptions);
    await writeSkill({
      dir: path.join(firstScope.executionWorkspaceDir, "skills", "demo"),
      name: "demo",
      description: "Changed first scope",
    });
    const directoryReads = vi.spyOn(fsSync, "readdirSync");
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch", sourceScopes: [firstScope] });
    const reconciledReadCount = directoryReads.mock.calls.length;
    expect(reconciledReadCount).toBeGreaterThan(0);
    expect(
      directoryReads.mock.calls.some(([dir]) =>
        String(dir).startsWith(secondScope.executionWorkspaceDir),
      ),
    ).toBe(false);
    expect(loadWorkspaceSkills(workspaceDir, firstOptions)[0]?.skill.description).toBe(
      "Changed first scope",
    );
    const reused = loadWorkspaceSkills(workspaceDir, secondOptions);
    expect(reused[0]).toBe(second[0]);
    expect(directoryReads).toHaveBeenCalledTimes(reconciledReadCount);
  });

  it("uses incoming roots before deciding whether a warm session can be reused", async () => {
    const workspaceDir = tempDirs.make("skills-content-roots-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const firstRoot = path.join(workspaceDir, "first");
    const secondRoot = path.join(workspaceDir, "second");
    await writeSkill({ dir: path.join(firstRoot, "demo"), name: "demo", description: "Before" });
    await writeSkill({ dir: path.join(secondRoot, "demo"), name: "demo", description: "After" });
    const firstConfig = { skills: { load: { extraDirs: [firstRoot] } } };
    const nextConfig = { skills: { load: { extraDirs: [secondRoot] } } };
    const first = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: firstConfig,
      watch: false,
    });
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      sourceScopes: [{}],
      refreshInputs: { sourceScope: {}, config: nextConfig },
    });
    const next = await resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: nextConfig,
      watch: false,
      existingSnapshot: first.snapshot,
    });
    expect(next.shouldRefresh).toBe(true);
    expect(next.snapshot.prompt).toContain("After");
    expect(next.snapshot.prompt).not.toContain("Before");
  });

  it("keeps retired worktrees out of global reconciliation and verifies them on reacquisition", async () => {
    const workspaceDir = tempDirs.make("skills-content-retired-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const executionWorkspaceDir = path.join(workspaceDir, "retired");
    const skillDir = path.join(executionWorkspaceDir, "skills", "retired");
    await writeSkill({ dir: skillDir, name: "retired", description: "Retired" });
    const options = {
      executionWorkspaceDir,
      bundledSkillsDir: "",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    };
    loadWorkspaceSkills(workspaceDir, options);
    const version = getSkillsSnapshotVersion(workspaceDir);
    suspendSkillsSnapshotSources(workspaceDir, { executionWorkspaceDir });
    await fs.rm(executionWorkspaceDir, { recursive: true });
    bumpSkillsSnapshotVersion({ reason: "workshop" });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      refreshInputs: { sourceScope: {} },
    });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      sourceScopes: [{ executionWorkspaceDir }],
      refreshInputs: { sourceScope: { executionWorkspaceDir } },
    });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
    expect(loadWorkspaceSkills(workspaceDir, options)).toEqual([]);
  });

  it("ignores losing skill edits but refreshes when the precedence winner disappears", async () => {
    const workspaceDir = tempDirs.make("skills-content-precedence-");
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDir);
    const executionWorkspaceDir = path.join(workspaceDir, "worktree");
    const winner = path.join(workspaceDir, "skills", "demo");
    const loser = path.join(executionWorkspaceDir, "skills", "demo");
    await writeSkill({ dir: winner, name: "demo", description: "Winner" });
    await writeSkill({ dir: loser, name: "demo", description: "Loser" });
    const options = {
      executionWorkspaceDir,
      bundledSkillsDir: "",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    };
    loadWorkspaceSkills(workspaceDir, options);
    const version = getSkillsSnapshotVersion(workspaceDir);
    await fs.appendFile(path.join(loser, "SKILL.md"), "\nChanged loser\n");
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    await fs.unlink(path.join(winner, "SKILL.md"));
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
    expect(loadWorkspaceSkills(workspaceDir, options)[0]?.skill.description).toBe("Loser");
  });
});
