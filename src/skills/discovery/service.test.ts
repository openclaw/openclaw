import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildWorkspaceSkillSnapshot as buildLegacyWorkspaceSkillSnapshot } from "../loading/workspace.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { buildSkillIndexCacheKey, buildWorkspaceSkillSnapshot, SkillsService } from "./service.js";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-service-"));
  tempDirs.push(dir);
  return dir;
}

function isolatedSkillRoots(workspaceDir: string) {
  return {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SkillsService", () => {
  it("does not load an index when the effective skill filter is empty", () => {
    type LoadIndexPatch = {
      loadIndex: () => never;
    };
    const service = new SkillsService();
    const patch = service as unknown as LoadIndexPatch;
    patch.loadIndex = () => {
      throw new Error("empty skill filters must not scan skill roots");
    };
    const config = {
      agents: { defaults: { skills: [] } },
    } satisfies OpenClawConfig;

    const explicit = service.buildSnapshot("/workspace/that/does/not/exist", {
      skillFilter: [],
      snapshotVersion: 11,
    });
    const fromConfig = service.buildSnapshot("/workspace/that/does/not/exist", {
      config,
      agentId: "demo-agent",
      snapshotVersion: 12,
    });

    expect(explicit).toMatchObject({ prompt: "", skills: [], resolvedSkills: [], version: 11 });
    expect(fromConfig).toMatchObject({ prompt: "", skills: [], resolvedSkills: [], version: 12 });
  });

  it("does not apply default skill filters without an agent id", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-default-filter", description: "Default filter workflow" },
    ]);
    const roots = isolatedSkillRoots(workspaceDir);
    const config = {
      agents: { defaults: { skills: [] } },
    } satisfies OpenClawConfig;

    const actual = buildWorkspaceSkillSnapshot(workspaceDir, {
      ...roots,
      config,
      snapshotVersion: 13,
    });
    const expected = buildLegacyWorkspaceSkillSnapshot(workspaceDir, {
      ...roots,
      config,
      snapshotVersion: 13,
    });

    expect(actual.prompt).toBe(expected.prompt);
    expect(actual.skills).toEqual(expected.skills);
    expect(actual.resolvedSkills).toEqual(expected.resolvedSkills);
    expect(actual.skills.map((skill) => skill.name)).toContain("service-default-filter");
  });

  it("builds snapshots from the index without changing prompt output", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "alpha", description: "Alpha workflow" },
      { name: "beta", description: "Beta workflow" },
    ]);
    const service = new SkillsService();
    const roots = isolatedSkillRoots(workspaceDir);

    const actual = service.buildSnapshot(workspaceDir, {
      ...roots,
      snapshotVersion: 42,
    });
    const expected = buildLegacyWorkspaceSkillSnapshot(workspaceDir, {
      ...roots,
      snapshotVersion: 42,
    });

    expect(actual.prompt).toBe(expected.prompt);
    expect(actual.skills).toEqual(expected.skills);
    expect(actual.resolvedSkills).toEqual(expected.resolvedSkills);
    expect(actual.version).toBe(42);
  });

  it("preserves the preloaded entries snapshot path", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "synthetic-entry-skill",
        description: "Synthetic entry",
        filePath: "/synthetic/skills/synthetic-entry-skill/SKILL.md",
        baseDir: "/synthetic/skills/synthetic-entry-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const snapshot = buildWorkspaceSkillSnapshot("/workspace/that/does/not/exist", {
      entries: [entry],
      snapshotVersion: 9,
    });

    expect(snapshot.prompt).toContain("synthetic-entry-skill");
    expect(snapshot.skills).toEqual([{ name: "synthetic-entry-skill" }]);
    expect(snapshot.resolvedSkills).toEqual([entry.skill]);
    expect(snapshot.version).toBe(9);
  });

  it("caches the source-aware index until the version key changes", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-cache-alpha", description: "Alpha workflow" },
    ]);
    const service = new SkillsService();
    const roots = isolatedSkillRoots(workspaceDir);

    const first = service.getIndex({ workspaceDir, ...roots, snapshotVersion: 1 });
    const second = service.getIndex({ workspaceDir, ...roots, snapshotVersion: 1 });
    const third = service.getIndex({ workspaceDir, ...roots, snapshotVersion: 2 });
    const firstAgain = service.getIndex({ workspaceDir, ...roots, snapshotVersion: 1 });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(firstAgain).not.toBe(first);
    expect(first.entries.find((entry) => entry.name === "service-cache-alpha")).toMatchObject({
      name: "service-cache-alpha",
      sourceKind: "workspace",
      owner: "workspace",
      writable: true,
      writableReason: "workspace-owned-skill",
    });
  });

  it("does not cache generation zero because it means no invalidation has happened yet", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-zero-alpha", description: "Alpha workflow" },
    ]);
    const service = new SkillsService();
    const roots = isolatedSkillRoots(workspaceDir);

    const before = service.getIndex({ workspaceDir, ...roots, snapshotVersion: 0 });
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-zero-beta", description: "Beta workflow" },
    ]);
    const after = service.getIndex({ workspaceDir, ...roots, snapshotVersion: 0 });

    expect(after).not.toBe(before);
    expect(before.entries.map((entry) => entry.name)).not.toContain("service-zero-beta");
    expect(after.entries.map((entry) => entry.name)).toContain("service-zero-beta");
  });

  it("does not cache explicit indexes when skill watching is disabled", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-watch-alpha", description: "Alpha workflow" },
    ]);
    const service = new SkillsService();
    const roots = isolatedSkillRoots(workspaceDir);
    const config = { skills: { load: { watch: false } } } satisfies OpenClawConfig;

    const before = service.getIndex({ workspaceDir, ...roots, config, snapshotVersion: 1 });
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-watch-beta", description: "Beta workflow" },
    ]);
    const after = service.getIndex({ workspaceDir, ...roots, config, snapshotVersion: 1 });

    expect(after).not.toBe(before);
    expect(before.entries.map((entry) => entry.name)).not.toContain("service-watch-beta");
    expect(after.entries.map((entry) => entry.name)).toContain("service-watch-beta");
  });

  it("keeps snapshots uncached even when callers pass a positive version", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-snapshot-alpha", description: "Alpha workflow" },
    ]);
    const service = new SkillsService();
    const roots = isolatedSkillRoots(workspaceDir);

    const before = service.buildSnapshot(workspaceDir, { ...roots, snapshotVersion: 1 });
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-snapshot-beta", description: "Beta workflow" },
    ]);
    const after = service.buildSnapshot(workspaceDir, { ...roots, snapshotVersion: 1 });

    expect(before.skills.map((skill) => skill.name)).not.toContain("service-snapshot-beta");
    expect(after.skills.map((skill) => skill.name)).toContain("service-snapshot-beta");
  });

  it("bounds cached indexes across workspace scopes", async () => {
    const service = new SkillsService();
    const workspaces = await Promise.all(
      Array.from({ length: 17 }, async (_, index) => {
        const workspaceDir = await makeTempWorkspace();
        await writeWorkspaceSkills(workspaceDir, [
          { name: `service-lru-${index}`, description: "Cached workflow" },
        ]);
        return workspaceDir;
      }),
    );
    const firstWorkspace = workspaces[0]!;
    const first = service.getIndex({
      workspaceDir: firstWorkspace,
      ...isolatedSkillRoots(firstWorkspace),
      snapshotVersion: 1,
    });

    for (const workspaceDir of workspaces.slice(1)) {
      service.getIndex({
        workspaceDir,
        ...isolatedSkillRoots(workspaceDir),
        snapshotVersion: 1,
      });
    }
    const firstAgain = service.getIndex({
      workspaceDir: firstWorkspace,
      ...isolatedSkillRoots(firstWorkspace),
      snapshotVersion: 1,
    });

    expect(firstAgain).not.toBe(first);
  });

  it("includes plugin config in the versioned cache key", async () => {
    const workspaceDir = await makeTempWorkspace();
    const roots = isolatedSkillRoots(workspaceDir);
    const enabledConfig = {
      plugins: { entries: { demo: { enabled: true } } },
    } satisfies OpenClawConfig;
    const disabledConfig = {
      plugins: { entries: { demo: { enabled: false } } },
    } satisfies OpenClawConfig;

    const enabledKey = buildSkillIndexCacheKey({
      workspaceDir,
      ...roots,
      config: enabledConfig,
      snapshotVersion: 1,
    });
    const disabledKey = buildSkillIndexCacheKey({
      workspaceDir,
      ...roots,
      config: disabledConfig,
      snapshotVersion: 1,
    });

    expect(enabledKey).not.toBe(disabledKey);
  });

  it("keeps legacy snapshot calls uncached unless a version is supplied", async () => {
    const workspaceDir = await makeTempWorkspace();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-legacy-alpha", description: "Alpha workflow" },
    ]);
    const service = new SkillsService();
    const roots = isolatedSkillRoots(workspaceDir);

    const before = service.buildSnapshot(workspaceDir, roots);
    await writeWorkspaceSkills(workspaceDir, [
      { name: "service-legacy-beta", description: "Beta workflow" },
    ]);
    const after = service.buildSnapshot(workspaceDir, roots);
    const beforeNames = before.skills.map((skill) => skill.name);
    const afterNames = after.skills.map((skill) => skill.name);

    expect(beforeNames).toContain("service-legacy-alpha");
    expect(beforeNames).not.toContain("service-legacy-beta");
    expect(afterNames).toContain("service-legacy-alpha");
    expect(afterNames).toContain("service-legacy-beta");
  });
});
