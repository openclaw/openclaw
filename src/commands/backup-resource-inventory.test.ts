import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createBackupResourcePlan,
  sealBackupResourceInventory,
} from "./backup-resource-inventory.js";

it("scoped plugin discovery preserves temporary exclusions, protected children, and custom roots", async () => {
  await withTempDir("backup-resource-scope-", async (stateDir) => {
    const pluginRoot = path.join(stateDir, "agents/main/agent/plugin");
    const temporaryRoot = path.join(pluginRoot, "tmp");
    const customRoot = path.join(pluginRoot, "custom");
    await fs.mkdir(path.join(temporaryRoot, "kept"), { recursive: true });
    await fs.mkdir(path.join(customRoot, "tmp"), { recursive: true });
    const resources = await createBackupResourcePlan({
      stateDir,
      configPaths: [],
      oauthDirs: [],
      workspaceDirs: [],
      excludedWorkspaceDirs: [],
      agentRoots: [
        {
          agentId: "custom",
          sourcePath: customRoot,
          databasePath: path.join(customRoot, "openclaw-agent.sqlite"),
        },
      ],
      pluginResources: ["agents/main/agent/plugin", "agents/main/agent/plugin/tmp/kept"].map(
        (relativePath) => ({
          pluginId: "retained",
          disposition: "include",
          scope: "state",
          relativePath,
        }),
      ),
      pluginRoots: [],
      temporaryRootScope: "plugin-resources",
    });
    expect(resources.isIncluded(temporaryRoot)).toBe(false);
    expect(resources.isTraversable(temporaryRoot)).toBe(true);
    expect(resources.isIncluded(path.join(temporaryRoot, "kept", "retained.sqlite"))).toBe(true);
    expect(resources.isIncluded(path.join(temporaryRoot, "discarded.sqlite"))).toBe(false);
    expect(resources.isIncluded(path.join(customRoot, "tmp", "retained.sqlite"))).toBe(true);
  });
});

it.each(["plan", "inventory"] as const)(
  "%s checks privacy once per traversal and observes later markers",
  async (kind) => {
    await withTempDir("backup-resource-privacy-", async (root) => {
      const stateDir = await fs.realpath(root);
      const parent = path.join(stateDir, "tmp");
      const protectedPath = path.join(parent, "durable");
      await fs.mkdir(protectedPath, { recursive: true });
      const resources = await createBackupResourcePlan({
        stateDir,
        configPaths: [],
        oauthDirs: [],
        workspaceDirs: [protectedPath],
        excludedWorkspaceDirs: [],
        agentRoots: [],
        pluginResources: [],
        pluginRoots: [],
      });
      const policy = kind === "plan" ? resources : sealBackupResourceInventory(resources, []);
      const marker = path.join(parent, ".openclaw-private-update-capture");
      let markerProbes = 0;
      const originalLstatSync = fsSync.lstatSync.bind(fsSync);
      using _ = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
        if (String(target) === marker) {
          markerProbes += 1;
        }
        return originalLstatSync(target, options);
      });

      // A protected child keeps its excluded parent traversable, with one filesystem scan.
      expect(policy.isTraversable(parent)).toBe(true);
      expect(markerProbes).toBe(1);
      expect(policy.isIncluded(parent)).toBe(false);
      expect(policy.isIncluded(protectedPath)).toBe(true);

      await fs.writeFile(marker, "openclaw-private-update-capture-v1\n");
      expect(policy.isTraversable(parent)).toBe(false);
      expect(policy.isIncluded(protectedPath)).toBe(false);
      await fs.writeFile(marker, "incomplete");
      expect(() => policy.isTraversable(parent)).toThrow("Private update capture marker");
      expect(() => policy.isIncluded(protectedPath)).toThrow("Private update capture marker");
    });
  },
);
