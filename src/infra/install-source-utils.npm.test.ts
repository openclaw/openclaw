import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { packNpmSpecToArchive } from "./install-source-utils.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

describe("npm archive output ownership", () => {
  it.each(["pack-destination", "dry-run"])(
    "packs into its workspace despite environment %s",
    async (setting) => {
      const root = await fs.realpath(await tempDirs.make("openclaw-npm-output-"));
      const packageDir = path.join(root, "source");
      const workspace = path.join(root, "workspace");
      const unrelatedDestination = path.join(root, "unrelated");
      await Promise.all([packageDir, workspace, unrelatedDestination].map((dir) => fs.mkdir(dir)));
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "openclaw-output-fixture", version: "1.0.0" }),
      );
      const value = setting === "pack-destination" ? unrelatedDestination : "true";
      const userConfig = path.join(root, "user.npmrc");
      const globalConfig = path.join(root, "global.npmrc");
      await fs.writeFile(userConfig, "");
      await fs.writeFile(globalConfig, "");
      for (const key of ["pack_destination", "dry_run", "userconfig", "globalconfig", "cache"]) {
        vi.stubEnv(`npm_config_${key}`, undefined);
        vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, undefined);
      }
      vi.stubEnv("npm_config_userconfig", userConfig);
      vi.stubEnv("npm_config_globalconfig", globalConfig);
      vi.stubEnv("npm_config_cache", path.join(root, "cache"));
      vi.stubEnv(`npm_config_${setting.replaceAll("-", "_")}`, value);

      const result = await packNpmSpecToArchive({
        spec: packageDir,
        cwd: workspace,
        timeoutMs: 30_000,
      });

      expect(result).toMatchObject({
        ok: true,
        archivePath: path.join(workspace, "openclaw-output-fixture-1.0.0.tgz"),
        metadata: { name: "openclaw-output-fixture", version: "1.0.0" },
      });
      expect(await fs.readdir(workspace)).toEqual(["openclaw-output-fixture-1.0.0.tgz"]);
      expect(await fs.readdir(unrelatedDestination)).toEqual([]);
    },
  );
});
