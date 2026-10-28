import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPluginVersions } from "../../scripts/sync-plugin-versions.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile as writeJson } from "../../test/helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeRoot(version: string) {
  const root = tempDirs.make("openclaw-sync-plugin-versions-");
  writeJson(path.join(root, "package.json"), { name: "openclaw", version });
  return root;
}

function readPackage(root: string, directory: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, directory, "package.json"), "utf8"));
}

function pluginPackage(version: string, floor: string) {
  return {
    name: "@openclaw/example",
    version,
    peerDependencies: { openclaw: floor },
    openclaw: { compat: { pluginApi: floor } },
  };
}

describe("syncPluginVersions", () => {
  it("aligns workspace versions while preserving workspace openclaw devDependencies", () => {
    const rootDir = makeRoot("2026.4.1");
    const privatePackage = { name: "@openclaw/llm-core", version: "0.0.0-private", private: true };
    const plugin = {
      ...pluginPackage("2026.3.30", ">=2026.3.30"),
      devDependencies: { openclaw: "workspace:*" },
    };
    writeJson(path.join(rootDir, "packages/ai/package.json"), {
      name: "@openclaw/ai",
      version: "2026.3.30",
    });
    writeJson(path.join(rootDir, "packages/llm-core/package.json"), privatePackage);
    writeJson(path.join(rootDir, "extensions/example/package.json"), plugin);
    const updated = ["@openclaw/ai", plugin.name];
    expect(syncPluginVersions(rootDir, { write: false }).updated).toEqual(updated);
    expect(readPackage(rootDir, "packages/ai")).toMatchObject({ version: "2026.3.30" });
    expect(readPackage(rootDir, "extensions/example")).toEqual(plugin);
    expect(syncPluginVersions(rootDir).updated).toEqual(updated);
    expect(readPackage(rootDir, "packages/ai")).toMatchObject({ version: "2026.4.1" });
    expect(readPackage(rootDir, "packages/llm-core")).toEqual(privatePackage);
    expect(readPackage(rootDir, "extensions/example")).toEqual({
      ...plugin,
      ...pluginPackage("2026.4.1", ">=2026.4.1"),
    });
  });

  it.each([
    ["2026.9.5", ">=2026.9.4", ">=2026.9.5"],
    ["2026.9.5", ">=2026.9.5", ">=2026.9.5"],
    ["2026.9.5", ">=2026.9.10", ">=2026.9.10"],
    ["2026.9.5-beta.2", ">=2026.9.5-beta.1", ">=2026.9.5-beta.2"],
    ["2026.9.5-beta.2", ">=2026.9.5-beta.10", ">=2026.9.5-beta.10"],
    ["2026.9.5-beta.2", ">=2026.9.5", ">=2026.9.5"],
    ["2026.9.5", ">=2026.9.5-1", ">=2026.9.5-1"],
    ["2026.9.5-1", ">=2026.9.5", ">=2026.9.5-1"],
    ["2026.9.5", ">=2026.9.5-rc.1", ">=2026.9.5"],
    ["2026.9.5", ">=2026.9.6-rc.1", ">=2026.9.6-rc.1"],
    ["2026.9.5", ">=2026.9.5.beta.1", ">=2026.9.5.beta.1"],
  ])("syncs release %s API and peer floors %s to %s", (version, current, expected) => {
    const rootDir = makeRoot(version);
    const packagePath = path.join(rootDir, "extensions/example/package.json");
    const pkg = pluginPackage(version, current);
    writeJson(packagePath, pkg);

    const updated = current === expected ? [] : [pkg.name];
    expect(syncPluginVersions(rootDir, { write: false }).updated).toEqual(updated);
    expect(readPackage(rootDir, "extensions/example")).toEqual(pkg);
    expect(syncPluginVersions(rootDir).updated).toEqual(updated);
    expect(readPackage(rootDir, "extensions/example")).toEqual(pluginPackage(version, expected));
  });

  it("uses the base release version for beta changelog entries", () => {
    const rootDir = makeRoot("2026.5.3-beta.1");
    const pkg = pluginPackage("2026.5.3-beta.1", ">=2026.5.3-beta.1");
    writeJson(path.join(rootDir, "extensions/example/package.json"), pkg);
    const changelogPath = path.join(rootDir, "extensions/example/CHANGELOG.md");
    fs.writeFileSync(
      changelogPath,
      "# Changelog\n\n## 2026.5.2\n\n### Changes\n\n- Previous release.\n",
      "utf8",
    );

    const summary = syncPluginVersions(rootDir);
    const changelog = fs.readFileSync(changelogPath, "utf8");

    expect(summary.changelogged).toEqual(["@openclaw/example"]);
    expect(changelog).toContain("## 2026.5.3\n\n### Changes\n- Version alignment");
    expect(changelog).not.toContain("## 2026.5.3-beta.1");

    expect(syncPluginVersions(rootDir, { write: false }).changelogged).toStrictEqual([]);
  });
});
