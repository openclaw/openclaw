import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createBackupResourcePlan,
  sealBackupResourceInventory,
} from "./backup-resource-inventory.js";

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retains refusal for a plugin resource declared after the agent scratch scan",
  async () => {
    await withTempDir("backup-explicit-unreadable-", async (root) => {
      const stateDir = await fs.realpath(root);
      const foreign = path.join(stateDir, "agents/main/agent/durable");
      await fs.mkdir(foreign, { recursive: true });
      await fs.chmod(foreign, 0);
      const lstat = fsSync.lstatSync;
      using _ = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        if (stat && args[0] === foreign) {
          Object.defineProperty(stat, "uid", { value: 0 });
        }
        return stat;
      });
      try {
        await expect(
          createBackupResourcePlan({
            stateDir,
            configPaths: [],
            oauthDirs: [],
            workspaceDirs: [],
            excludedWorkspaceDirs: [],
            agentRoots: [],
            pluginRoots: [],
            pluginResources: [
              {
                pluginId: "selected",
                disposition: "include",
                scope: "state",
                relativePath: "agents/main/agent/durable",
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await fs.chmod(foreign, 0o700);
      }
    });
  },
);

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
