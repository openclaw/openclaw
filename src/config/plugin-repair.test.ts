import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repairPluginConfigNoise } from "./plugin-repair.js";
import type { OpenClawConfig } from "./types.js";

describe("repairPluginConfigNoise", () => {
  it("does not prune load paths based on directory basename alone", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-repair-"));
    try {
      const archivedDir = path.join(fixtureRoot, "google-antigravity-auth");
      await fs.mkdir(archivedDir, { recursive: true });

      const cfg: OpenClawConfig = {
        plugins: {
          load: { paths: [archivedDir] },
        },
      };

      const repaired = repairPluginConfigNoise(cfg);

      expect(repaired.changes).toEqual([]);
      expect(repaired.config.plugins?.load?.paths).toEqual([archivedDir]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves unknown plugins.load fields when rebuilding repaired config", () => {
    const customPath = "/tmp/custom-plugin";
    const cfg = {
      plugins: {
        allow: ["google-antigravity-auth", "discord"],
        load: {
          paths: [customPath],
          priority: "after-bundled",
        },
      },
    } as unknown as OpenClawConfig;

    const repaired = repairPluginConfigNoise(cfg);
    const repairedLoad = repaired.config.plugins?.load as
      | {
          paths?: string[];
          priority?: string;
        }
      | undefined;

    expect(repaired.changes).toContain('- Removed plugins.allow entry "google-antigravity-auth"');
    expect(repaired.config.plugins?.allow).toEqual(["discord"]);
    expect(repairedLoad).toEqual({
      paths: [customPath],
      priority: "after-bundled",
    });
  });

  it("preserves unknown plugins.load fields when stale load paths are fully pruned", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-repair-"));
    try {
      const removedDir = path.join(fixtureRoot, "removed-plugin");
      await fs.mkdir(removedDir, { recursive: true });
      await fs.writeFile(
        path.join(removedDir, "openclaw.plugin.json"),
        JSON.stringify(
          {
            id: "google-antigravity-auth",
            configSchema: { type: "object" },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const cfg = {
        plugins: {
          load: {
            paths: [removedDir],
            priority: "after-bundled",
          },
        },
      } as unknown as OpenClawConfig;

      const repaired = repairPluginConfigNoise(cfg);
      const repairedLoad = repaired.config.plugins?.load as
        | {
            paths?: string[];
            priority?: string;
          }
        | undefined;

      expect(repaired.changes).toContain(
        '- Removed plugins.load.paths entry for removed plugin "google-antigravity-auth"',
      );
      expect(repairedLoad).toEqual({
        priority: "after-bundled",
      });
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
