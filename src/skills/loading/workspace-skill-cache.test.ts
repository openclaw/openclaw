import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import {
  loadWorkspaceSkillDiscovery,
  loadWorkspaceSkills,
  prepareWorkspaceSkills,
} from "./workspace-skill-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let envSnapshot: SkillsHomeEnvSnapshot | undefined;

afterEach(async () => {
  if (envSnapshot) {
    await restoreMockSkillsHomeEnv(envSnapshot);
    envSnapshot = undefined;
  }
});

describe("workspace skill discovery cache", () => {
  it("reuses agent discovery across execution scopes and refreshes only changed sources", async () => {
    const root = tempDirs.make("openclaw-skill-cache-");
    const fakeHome = path.join(root, "home");
    await fs.mkdir(fakeHome);
    envSnapshot = setMockSkillsHomeEnv(fakeHome);
    const workspaceDir = path.join(root, "agent");
    const executionDirs = [
      path.join(root, "first-execution"),
      path.join(root, "second-execution"),
    ] as const;
    await writeWorkspaceSkills(workspaceDir, [
      { name: "cached-skill", description: "Agent skill" },
      { name: "broken-agent", description: "" },
    ]);
    for (const executionDir of executionDirs) {
      await writeWorkspaceSkills(executionDir, [
        { name: "cached-skill", description: "Losing execution copy" },
        { name: "execution-skill", description: executionDir },
        { name: "broken-execution", description: "" },
      ]);
    }
    const options = {
      config: { plugins: { enabled: false } },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    };
    const directoryReads = vi.spyOn(fsSync, "opendirSync");
    const reads = (dir: string) =>
      directoryReads.mock.calls.filter(([file]) => String(file) === path.join(dir, "skills"))
        .length;
    const scoped = (executionWorkspaceDir: string) => ({ ...options, executionWorkspaceDir });
    try {
      const first = loadWorkspaceSkills(workspaceDir, options);
      const agentDiagnostics = loadWorkspaceSkillDiscovery(workspaceDir, options).diagnostics;
      expect(agentDiagnostics).toEqual({
        items: [
          {
            kind: "invalid",
            path: path.join(workspaceDir, "skills", "broken-agent", "SKILL.md"),
            message: "description is required",
          },
        ],
        omitted: 0,
      });
      const initialReadCount = directoryReads.mock.calls.length;
      expect(reads(workspaceDir)).toBe(1);
      expect(
        loadWorkspaceSkills(workspaceDir, { ...options, skillFilter: ["cached-skill"] })[0],
      ).toBe(first[0]);
      expect(directoryReads).toHaveBeenCalledTimes(initialReadCount);
      for (const executionDir of executionDirs) {
        const entries = await prepareWorkspaceSkills(workspaceDir, scoped(executionDir));
        expect(entries.map((entry) => entry.skill.name)).toEqual([
          "cached-skill",
          "execution-skill",
        ]);
        expect(entries[0]?.skill.description).toBe("Agent skill");
        expect(entries[1]?.skill.description).toBe(executionDir);
        expect(loadWorkspaceSkillDiscovery(workspaceDir, scoped(executionDir)).diagnostics).toEqual(
          {
            items: [
              ...agentDiagnostics.items,
              {
                kind: "invalid",
                path: path.join(executionDir, "skills", "broken-execution", "SKILL.md"),
                message: "description is required",
              },
            ],
            omitted: 0,
          },
        );
        expect(reads(executionDir)).toBe(1);
      }
      expect(agentDiagnostics.items).toHaveLength(1);
      expect(reads(workspaceDir)).toBe(1);
      const changedExecutionDir = executionDirs[0];
      const version = getSkillsSnapshotVersion(workspaceDir);
      await writeWorkspaceSkills(changedExecutionDir, [
        { name: "cached-skill", description: "Changed loser" },
        // Match the issue's invalid continuation; "[" is recovered as a valid description.
        { name: "broken-execution", description: "First line\ncontinued at column zero" },
      ]);
      bumpSkillsSnapshotVersion({
        workspaceDir,
        reason: "watch",
        sourceScopes: [scoped(changedExecutionDir)],
      });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(reads(workspaceDir)).toBe(1);
      expect(reads(changedExecutionDir)).toBe(2);
      expect(reads(executionDirs[1])).toBe(1);
      expect(
        loadWorkspaceSkillDiscovery(workspaceDir, scoped(changedExecutionDir)).diagnostics.items[1]
          ?.message,
      ).toContain("invalid frontmatter");
      expect(
        loadWorkspaceSkillDiscovery(workspaceDir, scoped(executionDirs[1])).diagnostics.items[1]
          ?.message,
      ).toBe("description is required");
      await writeWorkspaceSkills(workspaceDir, [
        { name: "fresh-skill", description: "Fresh skill" },
      ]);
      expect(loadWorkspaceSkills(workspaceDir, options)).toEqual(first);
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      for (const executionDir of executionDirs) {
        expect(
          loadWorkspaceSkills(workspaceDir, scoped(executionDir)).map((entry) => entry.skill.name),
        ).toEqual(["cached-skill", "fresh-skill", "execution-skill"]);
      }
      expect(reads(workspaceDir)).toBe(2);
    } finally {
      directoryReads.mockRestore();
    }
  });
});
