import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeWorkspaceSkills } from "./e2e-test-helpers.js";
import { buildSkillIndexCacheKey, SkillsService } from "./service.js";
import { buildWorkspaceSkillSnapshot as buildLegacyWorkspaceSkillSnapshot } from "./workspace.js";

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
