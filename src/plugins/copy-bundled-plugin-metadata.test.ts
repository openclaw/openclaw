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

function expectFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [file, contents] of Object.entries(files)) {
    expect(fs.readFileSync(path.join(root, file))).toEqual(Buffer.from(contents));
  }
}

function createPlugin(
  repoRoot: string,
  id: string,
  manifest: Record<string, unknown> = {},
  withoutEntry = false,
) {
  const pluginDir = path.join(repoRoot, "extensions", id);
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id,
    configSchema: { type: "object" },
    ...manifest,
  });
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${id}`,
    ...(!withoutEntry ? { openclaw: { extensions: ["./index.ts"] } } : {}),
  });
  return pluginDir;
}

function readBundledManifest(repoRoot: string, pluginId: string): Record<string, unknown> {
  return JSON.parse(
    readText(bundledPluginDir(repoRoot, pluginId), "openclaw.plugin.json"),
  ) as Record<string, unknown>;
}

function bundledPluginDir(repoRoot: string, pluginId: string) {
  return path.join(repoRoot, "dist", "extensions", pluginId);
}

function expectBundledSkills(repoRoot: string, pluginId: string, skills: string[]) {
  expect(readBundledManifest(repoRoot, pluginId).skills).toEqual(skills);
}

function fixture(id: string, manifest: Record<string, unknown> = {}) {
  const repoRoot = makeRepoRoot("openclaw-bundled-plugin-");
  const pluginDir = createPlugin(repoRoot, id, manifest);
  return { repoRoot, pluginDir, distDir: bundledPluginDir(repoRoot, id) };
}

function skillFixture() {
  const result = fixture("tlon", { skills: ["node_modules/@tloncorp/tlon-skill"] });
  return {
    ...result,
    legacy: path.join(result.distDir, "node_modules/@tloncorp/tlon-skill"),
    copied: path.join(result.distDir, "bundled-skills/@tloncorp/tlon-skill"),
  };
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

afterEach(() => cleanupTempDirs(tempDirs));

describe("copyBundledPluginMetadata", () => {
  it.each([false, true])(
    "copies owned channel Settings declarations from generated=%s metadata without touching siblings",
    (generated) => {
      const controlUi = {
        entry: "dist/control-ui/fixture/index.js",
        activation: "settings-only",
        settingsViews: [{ section: "channels", panel: "detail", channelId: "custom" }],
      };
      const { repoRoot, pluginDir } = fixture("profile-fixture", {
        channels: ["custom"],
        controlUi,
      });
      if (generated) {
        writeJsonFile(path.join(pluginDir, "package.json"), {
          name: "@openclaw/profile-fixture",
          openclaw: { extensions: ["./index.ts"], controlUi: "./browser.ts" },
        });
        writeJsonFile(path.join(pluginDir, "dist/openclaw.plugin.json"), { controlUi });
      }
      const sibling = bundledPluginDir(repoRoot, "sibling");
      const siblingFiles = {
        "index.js": "preserve runtime",
        "openclaw.plugin.json": '{"id":"sibling"}',
      };
      writeFiles(sibling, siblingFiles);
      copyBundledPluginMetadata({ repoRoot, pluginIds: new Set(["profile-fixture"]) });
      expect(readBundledManifest(repoRoot, "profile-fixture")).toMatchObject({
        channels: ["custom"],
        controlUi,
      });
      expectFiles(sibling, siblingFiles);
    },
  );
  it("copies plugin metadata, README, activity artwork, and skills without replacing runtime assets", () => {
    const { repoRoot, pluginDir, distDir } = fixture("acpx", {
      skills: ["./skills"],
      themes: [
        {
          ...theme("themes/workshop.json", "assets/theme-art/beret.svg"),
          critters: { ferris: { source: "assets/theme-art/ferris.svg" } },
        },
      ],
    });
    const activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>';
    const copiedFiles = {
      "README.md": "# ACP overview\n",
      "skills/acp-router/SKILL.md": "# ACP Router\n",
      "assets/icon.png": Buffer.from("package icon"),
      "assets/activity.svg": activityIcon,
      "themes/workshop.json": '{"name":"Workshop"}',
      "assets/theme-art/beret.svg": activityIcon,
      "assets/theme-art/ferris.svg": activityIcon,
      "assets/activity/acp_status.svg": activityIcon,
    };
    writeFiles(pluginDir, {
      ...copiedFiles,
      "assets/activity/notes.txt": "not artwork",
      "assets/activity/bad name.svg": activityIcon,
    });
    const distAssetsDir = path.join(distDir, "assets");
    writeFiles(distAssetsDir, {
      "activity/retired.svg": "stale",
      "runtime.js": "keep runtime asset",
    });

    copyBundledPluginMetadata({ repoRoot });

    expectBundledSkills(repoRoot, "acpx", ["./skills"]);
    expectFiles(distDir, { ...copiedFiles, "assets/runtime.js": "keep runtime asset" });
    expect(fs.readdirSync(path.join(distAssetsDir, "activity"))).toEqual(["acp_status.svg"]);
    expect(JSON.parse(readText(distDir, "package.json"))).toMatchObject({
      openclaw: { extensions: ["./index.js"] },
    });
  });

  it.skipIf(process.platform === "win32")("does not copy escaped theme artwork", () => {
    const { repoRoot, pluginDir, distDir } = fixture("acpx", {
      themes: [theme("theme.json", "art/beret.svg")],
    });
    const outside = path.join(repoRoot, "outside.svg");
    writeFiles(repoRoot, { "outside.svg": "outside bytes" });
    writeFiles(distDir, { "art/beret.svg": "stale bytes" });
    fs.mkdirSync(path.join(pluginDir, "art"));
    fs.symlinkSync(outside, path.join(pluginDir, "art/beret.svg"));

    copyBundledPluginMetadata({ repoRoot });

    expect(fs.existsSync(path.join(distDir, "art/beret.svg"))).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes");
  });

  it("copies generated bundled channel config schemas into dist manifests", () => {
    const staleHints = { "channels.telegram.stale": { help: "stale hint" } };
    const schema = { type: "object", properties: { groups: { type: "object" } } };
    const uiHints = { "channels.telegram.groups": { help: "generated hint" } };
    const { repoRoot } = fixture("telegram", {
      channels: ["telegram"],
      channelConfigs: {
        telegram: {
          schema: { type: "object", properties: { stale: { type: "boolean" } } },
          uiHints: staleHints,
        },
      },
    });
    const generated = [
      {
        pluginId: "telegram",
        channelId: "telegram",
        label: "Telegram",
        schema,
        uiHints,
      },
    ];
    writeFiles(repoRoot, {
      "src/config/bundled-channel-config-metadata.generated.ts": `export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ${JSON.stringify(generated)} as const;\n`,
    });

    copyBundledPluginMetadata({ repoRoot });

    const manifest = readBundledManifest(repoRoot, "telegram");
    expect(manifest.channelConfigs).toEqual({
      telegram: {
        schema,
        label: "Telegram",
        uiHints: { ...uiHints, ...staleHints },
      },
    });
  });

  it.each(["package symlink", "hoisted"])(
    "relocates %s skills and rewrites the manifest",
    (layout) => {
      const { repoRoot, pluginDir, legacy, copied } = skillFixture();
      const packageSkillDir = path.join(pluginDir, "node_modules/@tloncorp/tlon-skill");
      const storeSkillDir = path.join(
        repoRoot,
        layout === "hoisted"
          ? "node_modules/@tloncorp/tlon-skill"
          : "node_modules/.pnpm/@tloncorp+tlon-skill@0.2.2/node_modules/@tloncorp/tlon-skill",
      );
      writeFiles(storeSkillDir, {
        "SKILL.md": "# Tlon Skill\n",
        "node_modules/.bin/tlon": "#!/bin/sh\n",
      });
      if (layout === "package symlink") {
        fs.mkdirSync(path.dirname(packageSkillDir), { recursive: true });
        fs.symlinkSync(
          storeSkillDir,
          packageSkillDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      writeFiles(legacy, { "stale.txt": "stale\n" });

      copyBundledPluginMetadata({ repoRoot });

      expect(readText(copied, "SKILL.md")).toBe("# Tlon Skill\n");
      expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(copied, "node_modules"))).toBe(false);
      expect(fs.existsSync(legacy)).toBe(false);
      expectBundledSkills(repoRoot, "tlon", ["./bundled-skills/@tloncorp/tlon-skill"]);
    },
  );

  it("omits missing declared skill paths and removes stale generated outputs", () => {
    const { repoRoot, distDir, copied } = skillFixture();
    writeFiles(copied, { "SKILL.md": "# stale\n" });
    const staleNodeModulesDir = path.join(distDir, "node_modules");
    fs.mkdirSync(staleNodeModulesDir, { recursive: true });

    copyBundledPluginMetadata({ repoRoot });

    expectBundledSkills(repoRoot, "tlon", []);
    expect(fs.existsSync(path.join(distDir, "bundled-skills"))).toBe(false);
    expect(fs.existsSync(staleNodeModulesDir)).toBe(false);
  });

  it("retries transient skill copy races from concurrent runtime postbuilds", () => {
    const { repoRoot, pluginDir } = fixture("diffs", { skills: ["./skills"] });
    writeFiles(pluginDir, { "skills/diffs/SKILL.md": "# Diffs\n" });

    const realCpSync = fs.cpSync.bind(fs);
    let attempts = 0;
    const cpSyncSpy = vi.spyOn(fs, "cpSync").mockImplementation((...args) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("race"), { code: "EEXIST" });
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

  it.each(["removed", "manifestless", "runtime support"])("reconciles %s dist outputs", (kind) => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-output-");
    const id = "fixture";
    const pluginDir = path.join(repoRoot, "extensions", id);
    const distDir = bundledPluginDir(repoRoot, id);
    const packageJson = {
      name: `@openclaw/${id}`,
      version: "0.0.1",
      private: true,
      type: "module",
    };
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
    if (kind === "runtime support") {
      writeJsonFile(path.join(pluginDir, "package.json"), packageJson);
      writeFiles(pluginDir, { "runtime-api.ts": "export {};\n" });
      writeFiles(distDir, { "runtime-api.js": "export {};\n" });
    } else {
      writeFiles(distDir, {
        "bundled-skills/@scope/skill/SKILL.md": "# stale\n",
        "index.js": "export default {}\n",
      });
      fs.mkdirSync(path.join(distDir, "node_modules"), { recursive: true });
      writeJsonFile(path.join(distDir, "openclaw.plugin.json"), {
        id,
        configSchema: { type: "object" },
        skills: ["./bundled-skills/@scope/skill"],
      });
      writeJsonFile(path.join(distDir, "package.json"), { name: `@openclaw/${id}` });
      if (kind === "manifestless") {
        fs.mkdirSync(path.join(pluginDir, "node_modules"), { recursive: true });
      }
    }
    copyBundledPluginMetadata({ repoRoot });
    expect(fs.existsSync(distDir)).toBe(kind === "runtime support");
    if (kind === "runtime support") {
      expectFiles(distDir, { "runtime-api.js": "export {};\n" });
      expect(fs.existsSync(path.join(distDir, "openclaw.plugin.json"))).toBe(false);
      expect(JSON.parse(readText(distDir, "package.json"))).toEqual(packageJson);
    }
  });

  it("refuses to remove dist plugin trees through a symlinked dist root", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-plugin-meta-symlink-");
    const targetDir = path.join(repoRoot, "gateway-dist");
    writeFiles(targetDir, { "extensions/acpx/index.js": "export {};\n" });
    createPlugin(repoRoot, "acpx", {}, true);
    const distLink = path.join(repoRoot, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => copyBundledPluginMetadata({ repoRoot })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expectFiles(targetDir, { "extensions/acpx/index.js": "export {};\n" });
  });
});
