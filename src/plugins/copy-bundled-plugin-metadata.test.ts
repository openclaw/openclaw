import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";

const tempDirs: string[] = [];
function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function readText(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function createPlugin(
  repoRoot: string,
  params: {
    id: string;
    manifest?: Record<string, unknown>;
    withoutEntry?: boolean;
  },
) {
  const pluginDir = path.join(repoRoot, "extensions", params.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id: params.id,
    configSchema: { type: "object" },
    ...params.manifest,
  });
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${params.id}`,
    ...(!params.withoutEntry ? { openclaw: { extensions: ["./index.ts"] } } : {}),
  });
  return pluginDir;
}

function readBundledManifest(repoRoot: string, pluginId: string): Record<string, unknown> {
  return JSON.parse(
    readText(bundledPluginDir(repoRoot, pluginId), "openclaw.plugin.json"),
  ) as Record<string, unknown>;
}

function readBundledPackageJson(repoRoot: string, pluginId: string) {
  return JSON.parse(readText(bundledPluginDir(repoRoot, pluginId), "package.json")) as {
    openclaw?: { extensions?: string[] };
  };
}

function bundledPluginDir(repoRoot: string, pluginId: string) {
  return path.join(repoRoot, "dist", "extensions", pluginId);
}

function bundledSkillPath(repoRoot: string, pluginId: string, ...relativePath: string[]) {
  return path.join(bundledPluginDir(repoRoot, pluginId), ...relativePath);
}

function expectBundledSkills(repoRoot: string, pluginId: string, skills: string[]) {
  expect(readBundledManifest(repoRoot, pluginId).skills).toEqual(skills);
}

function createTlonSkillPlugin(repoRoot: string, skillPath = "node_modules/@tloncorp/tlon-skill") {
  return createPlugin(repoRoot, {
    id: "tlon",
    manifest: { skills: [skillPath] },
  });
}

function theme(source: string, beret: string) {
  return {
    id: "workshop",
    name: "Workshop",
    description: "Workshop colors",
    source,
    hats: { beret },
  };
}

function writeStaleMetadata(dir: string, id: string, skills?: string[]) {
  writeJsonFile(path.join(dir, "openclaw.plugin.json"), {
    id,
    configSchema: { type: "object" },
    ...(skills ? { skills } : {}),
  });
  writeJsonFile(path.join(dir, "package.json"), { name: `@openclaw/${id}` });
}

afterEach(() => cleanupTempDirs(tempDirs));

describe("copyBundledPluginMetadata", () => {
  it.each([false, true])(
    "copies owned channel Settings declarations from generated=%s metadata without touching siblings",
    (generated) => {
      const repoRoot = makeRepoRoot("openclaw-bundled-channel-settings-");
      const controlUi = {
        entry: "dist/control-ui/fixture/index.js",
        activation: "settings-only",
        settingsViews: [{ section: "channels", panel: "detail", channelId: "custom" }],
      };
      const pluginDir = createPlugin(repoRoot, {
        id: "profile-fixture",
        manifest: { channels: ["custom"], controlUi },
      });
      if (generated) {
        writeJsonFile(path.join(pluginDir, "package.json"), {
          name: "@openclaw/profile-fixture",
          openclaw: { extensions: ["./index.ts"], controlUi: "./browser.ts" },
        });
        writeJsonFile(path.join(pluginDir, "dist/openclaw.plugin.json"), { controlUi });
      }
      const sibling = bundledPluginDir(repoRoot, "sibling");
      writeFiles(sibling, {
        "index.js": "preserve runtime",
        "openclaw.plugin.json": '{"id":"sibling"}',
      });
      copyBundledPluginMetadata({ repoRoot, pluginIds: new Set(["profile-fixture"]) });
      expect(readBundledManifest(repoRoot, "profile-fixture")).toMatchObject({
        channels: ["custom"],
        controlUi,
      });
      expect(readText(sibling, "index.js")).toBe("preserve runtime");
      expect(readText(sibling, "openclaw.plugin.json")).toBe('{"id":"sibling"}');
    },
  );
  it("copies plugin metadata, README, activity artwork, and skills without replacing runtime assets", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-meta-");
    const pluginDir = createPlugin(repoRoot, {
      id: "acpx",
      manifest: {
        skills: ["./skills"],
        themes: [
          {
            ...theme("themes/workshop.json", "assets/theme-art/beret.svg"),
            critters: { ferris: { source: "assets/theme-art/ferris.svg" } },
          },
        ],
      },
    });
    const activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>';
    writeFiles(pluginDir, {
      "README.md": "# ACP overview\n",
      "skills/acp-router/SKILL.md": "# ACP Router\n",
      "assets/icon.png": Buffer.from("package icon"),
      "assets/activity.svg": activityIcon,
      "themes/workshop.json": '{"name":"Workshop"}',
      "assets/theme-art/beret.svg": activityIcon,
      "assets/theme-art/ferris.svg": activityIcon,
      "assets/activity/acp_status.svg": activityIcon,
      "assets/activity/notes.txt": "not artwork",
      "assets/activity/bad name.svg": activityIcon,
    });
    const distDir = bundledPluginDir(repoRoot, "acpx");
    const distAssetsDir = path.join(bundledPluginDir(repoRoot, "acpx"), "assets");
    writeFiles(distAssetsDir, {
      "activity/retired.svg": "stale",
      "runtime.js": "keep runtime asset",
    });

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(path.join(distDir, "openclaw.plugin.json"))).toBe(true);
    expect(readText(distDir, "skills/acp-router/SKILL.md")).toContain("ACP Router");
    expectBundledSkills(repoRoot, "acpx", ["./skills"]);
    expect(readText(distDir, "README.md")).toBe("# ACP overview\n");
    expect(fs.readFileSync(path.join(distAssetsDir, "icon.png"))).toEqual(
      Buffer.from("package icon"),
    );
    expect(readText(distAssetsDir, "activity.svg")).toBe(activityIcon);
    expect(readText(distAssetsDir, "theme-art/beret.svg")).toBe(activityIcon);
    expect(readText(distAssetsDir, "theme-art/ferris.svg")).toBe(activityIcon);
    expect(readText(distDir, "themes/workshop.json")).toBe('{"name":"Workshop"}');
    expect(fs.readdirSync(path.join(distAssetsDir, "activity"))).toEqual(["acp_status.svg"]);
    expect(readText(distAssetsDir, "activity/acp_status.svg")).toBe(activityIcon);
    expect(readText(distAssetsDir, "runtime.js")).toBe("keep runtime asset");
    const packageJson = readBundledPackageJson(repoRoot, "acpx");
    expect(packageJson.openclaw?.extensions).toEqual(["./index.js"]);
  });

  it.skipIf(process.platform === "win32")("does not copy escaped theme artwork", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-theme-boundary-");
    const pluginDir = createPlugin(repoRoot, {
      id: "acpx",
      manifest: {
        themes: [theme("theme.json", "art/beret.svg")],
      },
    });
    const outside = path.join(repoRoot, "outside.svg");
    fs.writeFileSync(outside, "outside bytes");
    fs.mkdirSync(path.join(pluginDir, "art"));
    fs.symlinkSync(outside, path.join(pluginDir, "art/beret.svg"));
    const target = path.join(bundledPluginDir(repoRoot, "acpx"), "art/beret.svg");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "stale bytes");

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes");
  });

  it("copies generated bundled channel config schemas into dist manifests", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-channel-config-meta-");
    createPlugin(repoRoot, {
      id: "telegram",
      manifest: {
        channels: ["telegram"],
        channelConfigs: {
          telegram: {
            schema: { type: "object", properties: { stale: { type: "boolean" } } },
            uiHints: {
              "channels.telegram.stale": { help: "stale hint" },
            },
          },
        },
      },
    });
    const generated = [
      {
        pluginId: "telegram",
        channelId: "telegram",
        label: "Telegram",
        schema: { type: "object", properties: { groups: { type: "object" } } },
        uiHints: { "channels.telegram.groups": { help: "generated hint" } },
      },
    ];
    writeFiles(repoRoot, {
      "src/config/bundled-channel-config-metadata.generated.ts": `export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ${JSON.stringify(generated)} as const;\n`,
    });

    copyBundledPluginMetadata({ repoRoot });

    const manifest = readBundledManifest(repoRoot, "telegram");
    expect(manifest.channelConfigs).toEqual({
      telegram: {
        schema: { type: "object", properties: { groups: { type: "object" } } },
        label: "Telegram",
        uiHints: {
          "channels.telegram.groups": { help: "generated hint" },
          "channels.telegram.stale": { help: "stale hint" },
        },
      },
    });
  });

  it("relocates node_modules-backed skill paths into bundled-skills and rewrites the manifest", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-node-modules-");
    const pluginDir = createTlonSkillPlugin(repoRoot);
    const storeSkillDir = path.join(
      repoRoot,
      "node_modules/.pnpm/@tloncorp+tlon-skill@0.2.2/node_modules/@tloncorp/tlon-skill",
    );
    writeFiles(storeSkillDir, {
      "SKILL.md": "# Tlon Skill\n",
      "node_modules/.bin/tlon": "#!/bin/sh\n",
    });
    fs.mkdirSync(path.join(pluginDir, "node_modules", "@tloncorp"), { recursive: true });
    fs.symlinkSync(
      storeSkillDir,
      path.join(pluginDir, "node_modules", "@tloncorp", "tlon-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const staleNodeModulesSkillDir = bundledSkillPath(
      repoRoot,
      "tlon",
      "node_modules/@tloncorp/tlon-skill",
    );
    writeFiles(staleNodeModulesSkillDir, { "stale.txt": "stale\n" });

    copyBundledPluginMetadata({ repoRoot });

    const copiedSkillDir = bundledSkillPath(
      repoRoot,
      "tlon",
      "bundled-skills/@tloncorp/tlon-skill",
    );
    expect(fs.existsSync(path.join(copiedSkillDir, "SKILL.md"))).toBe(true);
    expect(fs.lstatSync(copiedSkillDir).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(copiedSkillDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(staleNodeModulesSkillDir)).toBe(false);
    expectBundledSkills(repoRoot, "tlon", ["./bundled-skills/@tloncorp/tlon-skill"]);
  });

  it("falls back to repo-root hoisted node_modules skill paths", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-hoisted-skill-");
    createTlonSkillPlugin(repoRoot);
    const hoistedSkillDir = path.join(repoRoot, "node_modules", "@tloncorp", "tlon-skill");
    writeFiles(hoistedSkillDir, { "SKILL.md": "# Hoisted Tlon Skill\n" });

    copyBundledPluginMetadata({ repoRoot });

    expect(
      readText(bundledPluginDir(repoRoot, "tlon"), "bundled-skills/@tloncorp/tlon-skill/SKILL.md"),
    ).toContain("Hoisted Tlon Skill");
    expectBundledSkills(repoRoot, "tlon", ["./bundled-skills/@tloncorp/tlon-skill"]);
  });

  it("omits missing declared skill paths and removes stale generated outputs", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-missing-skill-");
    createTlonSkillPlugin(repoRoot);
    const staleBundledSkillDir = bundledSkillPath(
      repoRoot,
      "tlon",
      "bundled-skills/@tloncorp/tlon-skill",
    );
    writeFiles(staleBundledSkillDir, { "SKILL.md": "# stale\n" });
    const staleNodeModulesDir = path.join(bundledPluginDir(repoRoot, "tlon"), "node_modules");
    fs.mkdirSync(staleNodeModulesDir, { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    expectBundledSkills(repoRoot, "tlon", []);
    expect(fs.existsSync(bundledSkillPath(repoRoot, "tlon", "bundled-skills"))).toBe(false);
    expect(fs.existsSync(staleNodeModulesDir)).toBe(false);
  });

  it("retries transient skill copy races from concurrent runtime postbuilds", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-retry-");
    const pluginDir = createPlugin(repoRoot, {
      id: "diffs",
      manifest: { skills: ["./skills"] },
    });
    writeFiles(pluginDir, { "skills/diffs/SKILL.md": "# Diffs\n" });

    const realCpSync = fs.cpSync.bind(fs);
    let attempts = 0;
    const cpSyncSpy = vi.spyOn(fs, "cpSync").mockImplementation((...args) => {
      attempts += 1;
      if (attempts === 1) {
        const error = Object.assign(new Error("race"), { code: "EEXIST" });
        throw error;
      }
      return realCpSync(...args);
    });

    try {
      copyBundledPluginMetadata({ repoRoot });
    } finally {
      cpSyncSpy.mockRestore();
    }

    expect(attempts).toBe(2);
    expect(readText(bundledPluginDir(repoRoot, "diffs"), "skills/diffs/SKILL.md")).toContain(
      "Diffs",
    );
  });

  it("removes generated outputs for plugins no longer present in source", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-removed-");
    const distDir = bundledPluginDir(repoRoot, "removed-plugin");
    writeFiles(distDir, {
      "bundled-skills/@scope/skill/SKILL.md": "# stale\n",
      "index.js": "export default {}\n",
    });
    fs.mkdirSync(path.join(distDir, "node_modules"), { recursive: true });
    writeStaleMetadata(distDir, "removed-plugin", ["./bundled-skills/@scope/skill"]);
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(distDir)).toBe(false);
  });

  it("removes stale dist outputs when a source extension directory no longer has a manifest", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-manifestless-source-");
    const sourcePluginDir = path.join(repoRoot, "extensions", "google-gemini-cli-auth");
    fs.mkdirSync(path.join(sourcePluginDir, "node_modules"), { recursive: true });
    const staleDistDir = bundledPluginDir(repoRoot, "google-gemini-cli-auth");
    writeFiles(staleDistDir, { "index.js": "export default {}\n" });
    writeStaleMetadata(staleDistDir, "google-gemini-cli-auth");

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(staleDistDir)).toBe(false);
  });

  it("preserves manifest-less runtime support package outputs and copies package metadata", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-runtime-support-");
    const pluginDir = path.join(repoRoot, "extensions", "image-generation-core");
    fs.mkdirSync(pluginDir, { recursive: true });
    const packageJson = {
      name: "@openclaw/image-generation-core",
      version: "0.0.1",
      private: true,
      type: "module",
    };
    writeJsonFile(path.join(pluginDir, "package.json"), packageJson);
    writeFiles(pluginDir, { "runtime-api.ts": "export {};\n" });
    const distDir = bundledPluginDir(repoRoot, "image-generation-core");
    writeFiles(distDir, { "runtime-api.js": "export {};\n" });

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(distDir)).toBe(true);
    expect(fs.existsSync(path.join(distDir, "runtime-api.js"))).toBe(true);
    expect(fs.existsSync(path.join(distDir, "openclaw.plugin.json"))).toBe(false);
    expect(JSON.parse(readText(distDir, "package.json"))).toEqual(packageJson);
  });

  it("refuses to remove dist plugin trees through a symlinked dist root", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-meta-symlink-");
    const targetDir = path.join(repoRoot, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "acpx", "index.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "export {};\n");
    createPlugin(repoRoot, { id: "acpx", withoutEntry: true });
    const distLink = path.join(repoRoot, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => copyBundledPluginMetadata({ repoRoot })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expect(fs.readFileSync(pluginFile, "utf8")).toBe("export {};\n");
  });
});
