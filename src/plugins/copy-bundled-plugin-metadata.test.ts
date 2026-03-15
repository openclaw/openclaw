import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyBundledPluginMetadata,
  rewritePackageExtensions,
} from "../../scripts/copy-bundled-plugin-metadata.mjs";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("rewritePackageExtensions", () => {
  it("rewrites TypeScript extension entries to built JS paths", () => {
    expect(rewritePackageExtensions(["./index.ts", "./nested/entry.mts"])).toEqual([
      "./index.js",
      "./nested/entry.js",
    ]);
  });
});

describe("copyBundledPluginMetadata", () => {
  it("copies plugin manifests, package metadata, and local skill directories", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-meta-");
    const pluginDir = path.join(repoRoot, "extensions", "acpx");
    fs.mkdirSync(path.join(pluginDir, "skills", "acp-router"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "skills", "acp-router", "SKILL.md"),
      "# ACP Router\n",
      "utf8",
    );
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "acpx",
      configSchema: { type: "object" },
      skills: ["./skills"],
    });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/acpx",
      openclaw: { extensions: ["./index.ts"] },
    });

    copyBundledPluginMetadata({ repoRoot });

    expect(
      fs.existsSync(path.join(repoRoot, "dist", "extensions", "acpx", "openclaw.plugin.json")),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "acpx", "skills", "acp-router", "SKILL.md"),
        "utf8",
      ),
    ).toContain("ACP Router");
    const bundledManifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "acpx", "openclaw.plugin.json"),
        "utf8",
      ),
    ) as { skills?: string[] };
    expect(bundledManifest.skills).toEqual(["./skills"]);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "dist", "extensions", "acpx", "package.json"), "utf8"),
    ) as { openclaw?: { extensions?: string[] } };
    expect(packageJson.openclaw?.extensions).toEqual(["./index.js"]);
  });

  it("relocates node_modules-backed skill paths into bundled-skills and rewrites the manifest", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-node-modules-");
    const pluginDir = path.join(repoRoot, "extensions", "tlon");
    const storeSkillDir = path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "@tloncorp+tlon-skill@0.2.2",
      "node_modules",
      "@tloncorp",
      "tlon-skill",
    );
    fs.mkdirSync(storeSkillDir, { recursive: true });
    fs.writeFileSync(path.join(storeSkillDir, "SKILL.md"), "# Tlon Skill\n", "utf8");
    fs.mkdirSync(path.join(pluginDir, "node_modules", "@tloncorp"), { recursive: true });
    fs.symlinkSync(
      storeSkillDir,
      path.join(pluginDir, "node_modules", "@tloncorp", "tlon-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "tlon",
      configSchema: { type: "object" },
      skills: ["node_modules/@tloncorp/tlon-skill"],
    });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/tlon",
      openclaw: { extensions: ["./index.ts"] },
    });
    const staleNodeModulesSkillDir = path.join(
      repoRoot,
      "dist",
      "extensions",
      "tlon",
      "node_modules",
      "@tloncorp",
      "tlon-skill",
    );
    fs.mkdirSync(staleNodeModulesSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleNodeModulesSkillDir, "stale.txt"), "stale\n", "utf8");

    copyBundledPluginMetadata({ repoRoot });

    const copiedSkillDir = path.join(
      repoRoot,
      "dist",
      "extensions",
      "tlon",
      "bundled-skills",
      "@tloncorp",
      "tlon-skill",
    );
    expect(fs.existsSync(path.join(copiedSkillDir, "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(copiedSkillDir).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "tlon", "node_modules"))).toBe(
      false,
    );
    const bundledManifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "tlon", "openclaw.plugin.json"),
        "utf8",
      ),
    ) as { skills?: string[] };
    expect(bundledManifest.skills).toEqual(["./bundled-skills/@tloncorp/tlon-skill"]);
  });

  it("omits missing declared skill paths and removes stale generated outputs", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-missing-skill-");
    const pluginDir = path.join(repoRoot, "extensions", "tlon");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id: "tlon",
      configSchema: { type: "object" },
      skills: ["node_modules/@tloncorp/tlon-skill"],
    });
    writeJson(path.join(pluginDir, "package.json"), {
      name: "@openclaw/tlon",
      openclaw: { extensions: ["./index.ts"] },
    });
    const staleBundledSkillDir = path.join(
      repoRoot,
      "dist",
      "extensions",
      "tlon",
      "bundled-skills",
      "@tloncorp",
      "tlon-skill",
    );
    fs.mkdirSync(staleBundledSkillDir, { recursive: true });
    fs.writeFileSync(path.join(staleBundledSkillDir, "SKILL.md"), "# stale\n", "utf8");
    const staleNodeModulesDir = path.join(repoRoot, "dist", "extensions", "tlon", "node_modules");
    fs.mkdirSync(staleNodeModulesDir, { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    const bundledManifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "tlon", "openclaw.plugin.json"),
        "utf8",
      ),
    ) as { skills?: string[] };
    expect(bundledManifest.skills).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "tlon", "bundled-skills"))).toBe(
      false,
    );
    expect(fs.existsSync(staleNodeModulesDir)).toBe(false);
  });
});
