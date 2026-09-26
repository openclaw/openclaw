import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  admitConfigObservationRoots,
  configObservationEntries,
  type ConfigObservationRootCache,
} from "./source-file-roots.js";

describe("config observation admission", () => {
  it("separates rejected lexical entries from allowed canonical targets", async () => {
    await withTestDir({ prefix: "config-observation-" }, async (workspace) => {
      const configDir = path.join(workspace, "config");
      const allowedDir = path.join(workspace, "shared");
      const untrustedDir = path.join(workspace, "other");
      await Promise.all([configDir, allowedDir, untrustedDir].map((entry) => fs.mkdir(entry)));
      const configPath = path.join(configDir, "openclaw.json");
      const lexical = path.join(configDir, "rejected.json");
      const untrusted = path.join(untrustedDir, "secret.json");
      await fs.writeFile(untrusted, "private");
      await fs.symlink(untrusted, lexical);
      const canonical = path.join(allowedDir, "shared.json");
      const roots = await admitConfigObservationRoots(configPath, [allowedDir]);
      const entries = roots.flatMap((entry) => [
        ...configObservationEntries(
          entry,
          new Set([configPath, lexical, canonical, untrusted]),
        ).values(),
      ]);
      expect(entries.toSorted()).toEqual([configPath, lexical, canonical].toSorted());
      // Observing the rejected link entry never grants a metadata read through it.
      const owner = roots.find(
        (entry) => configObservationEntries(entry, new Set([lexical])).size > 0,
      )!;
      await expect(
        owner.authority.open(path.relative(owner.authority.rootDir, lexical), {
          symlinks: "reject",
        }),
      ).rejects.toThrow();
    });
  });

  it("keeps an admitted canonical include boundary after its configured alias retargets", async () => {
    await withTestDir({ prefix: "config-boundary-retarget-" }, async (workspace) => {
      const configDir = path.join(workspace, "config");
      const first = path.join(workspace, "first");
      const second = path.join(workspace, "second");
      await Promise.all([configDir, first, second].map((dir) => fs.mkdir(dir)));
      const alias = path.join(workspace, "allowed");
      await fs.symlink(first, alias, process.platform === "win32" ? "junction" : "dir");
      const cache: ConfigObservationRootCache = {
        roots: new Map(),
        canonicalBoundaries: new Map(),
      };
      const configPath = path.join(configDir, "openclaw.json");
      const before = await admitConfigObservationRoots(configPath, [alias], cache);
      const files = new Set([path.join(first, "include.json"), path.join(second, "include.json")]);
      const selected = (roots: typeof before) =>
        roots.flatMap((owner) => [...configObservationEntries(owner, files).values()]);
      expect(selected(before)).toEqual([path.join(first, "include.json")]);
      const lexical = path.join(alias, "include.json");
      const mapped = (roots: typeof before) =>
        roots.flatMap((owner) => [...configObservationEntries(owner, new Set([lexical])).values()]);
      expect(mapped(before).toSorted()).toEqual(
        [lexical, path.join(first, "include.json")].toSorted(),
      );
      await fs.unlink(alias);
      await fs.symlink(second, alias, process.platform === "win32" ? "junction" : "dir");
      const after = await admitConfigObservationRoots(configPath, [alias], cache);
      expect(selected(after)).toEqual([path.join(first, "include.json")]);
      expect(mapped(after).toSorted()).toEqual(
        [lexical, path.join(first, "include.json")].toSorted(),
      );
      expect(after.map((owner) => owner.authority)).toEqual(before.map((owner) => owner.authority));
      expect(cache.roots.has(second)).toBe(false);
      // Only a new caller-supplied boundary, not retrying the old alias, admits B.
      const explicitlyAdmitted = await admitConfigObservationRoots(
        configPath,
        [alias, second],
        cache,
      );
      expect(selected(explicitlyAdmitted).toSorted()).toEqual([...files].toSorted());
    });
  });

  it("pins a stable ancestor for missing descendants without renewing a replaced Root", async () => {
    await withTestDir({ prefix: "config-observation-" }, async (workspace) => {
      const stable = path.join(workspace, "stable");
      await fs.mkdir(stable);
      const configPath = path.join(stable, "missing", "deep", "openclaw.json");
      const roots = await admitConfigObservationRoots(configPath, []);
      expect(roots).toHaveLength(1);
      const owner = roots[0]!;
      expect(owner.authority.rootDir).toBe(stable);
      expect([...configObservationEntries(owner, new Set([configPath])).keys()]).toEqual([
        path.join("missing", "deep", "openclaw.json"),
      ]);
      await fs.rename(stable, `${stable}-old`);
      await fs.mkdir(stable);
      await expect(owner.authority.stat(".")).rejects.toThrow();
    });
  });
});
