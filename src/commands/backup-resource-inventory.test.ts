import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createBackupResourcePlan,
  sealBackupResourceInventory,
} from "./backup-resource-inventory.js";

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

it.skipIf(process.platform === "win32")(
  "rejects unrelated exclusions without repeated path resolution",
  async () => {
    await withTempDir("backup-resource-path-work-", async (stateDir) => {
      const excluded = path.join(stateDir, "tmp");
      const protectedPath = path.join(excluded, "durable");
      const plan = await createBackupResourcePlan({
        stateDir,
        configPaths: [],
        oauthDirs: [],
        workspaceDirs: [protectedPath],
        excludedWorkspaceDirs: [],
        agentRoots: [],
        pluginResources: [],
        pluginRoots: Array.from({ length: 85 }, (_, i) =>
          path.join(stateDir, "plugins", String(i)),
        ),
      });
      const included = path.join(stateDir, "workspace", "document.txt");
      using relative = vi.spyOn(path, "relative");
      expect(plan.isIncludedByOwner(included)).toBe(true);
      expect(relative).not.toHaveBeenCalled();
      expect(plan.isIncludedByOwner(path.join(excluded, "scratch"))).toBe(false);
      expect(plan.isIncludedByOwner(protectedPath)).toBe(true);
      expect(plan.isIncludedByOwner(path.join(stateDir, "tmp-sibling", "keep"))).toBe(true);
      expect(plan.isIncludedByOwner(`${stateDir}/workspace/../tmp/scratch`)).toBe(false);
    });
  },
);
