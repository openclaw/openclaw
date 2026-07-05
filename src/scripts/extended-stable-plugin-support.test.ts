import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadExtendedStablePluginSupport,
  parseExtendedStablePluginSupport,
  validateExtendedStablePluginPackages,
} from "../../scripts/lib/extended-stable-plugin-support.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const tempDirs: string[] = [];

const validPolicy = {
  schemaVersion: 1,
  plugins: [
    {
      pluginId: "codex",
      packageName: "@openclaw/codex",
      packageDir: "extensions/codex",
      acceptanceProfile: "codex-provider-v1",
    },
    {
      pluginId: "discord",
      packageName: "@openclaw/discord",
      packageDir: "extensions/discord",
      acceptanceProfile: "discord-channel-v1",
    },
    {
      pluginId: "slack",
      packageName: "@openclaw/slack",
      packageDir: "extensions/slack",
      acceptanceProfile: "slack-channel-v1",
    },
  ],
} as const;

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFixture(rootDir: string, version = "2026.7.33") {
  writeJson(path.join(rootDir, "release/extended-stable-plugin-support.json"), validPolicy);
  for (const plugin of validPolicy.plugins) {
    writeJson(path.join(rootDir, plugin.packageDir, "package.json"), {
      name: plugin.packageName,
      version,
    });
  }
}

describe("extended-stable plugin support policy", () => {
  afterEach(() => cleanupTempDirs(tempDirs));

  it("loads the fixed Slack, Discord, and Codex support set", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-extended-stable-support-");
    writeFixture(rootDir);

    const support = loadExtendedStablePluginSupport(rootDir);
    expect(support.plugins.map((entry) => entry.packageName)).toEqual([
      "@openclaw/codex",
      "@openclaw/discord",
      "@openclaw/slack",
    ]);
    expect(validateExtendedStablePluginPackages({ rootDir, targetVersion: "2026.7.33" })).toEqual(
      support,
    );
  });

  it("rejects unknown fields, unsafe identities, and unregistered profiles", () => {
    expect(() => parseExtendedStablePluginSupport({ ...validPolicy, generatedAt: "now" })).toThrow(
      /must contain exactly/u,
    );

    expect(() =>
      parseExtendedStablePluginSupport({
        ...validPolicy,
        plugins: [validPolicy.plugins[1], validPolicy.plugins[0], validPolicy.plugins[2]],
      }),
    ).toThrow(/sorted by packageName/u);

    expect(() =>
      parseExtendedStablePluginSupport({
        ...validPolicy,
        plugins: [
          ...validPolicy.plugins.slice(0, 2),
          { ...validPolicy.plugins[2], packageDir: "../slack" },
        ],
      }),
    ).toThrow(/packageDir must be a safe relative path ending in pluginId/u);

    expect(() =>
      parseExtendedStablePluginSupport({
        ...validPolicy,
        plugins: [
          ...validPolicy.plugins.slice(0, 2),
          { ...validPolicy.plugins[2], acceptanceProfile: "unknown-v1" },
        ],
      }),
    ).toThrow(/acceptanceProfile is not registered/u);
  });

  it("keeps the checked-in human-owned policy at the approved three-plugin boundary", () => {
    const support = loadExtendedStablePluginSupport(process.cwd());
    expect(support).toEqual(validPolicy);
  });

  it("rejects package identity and root-version drift", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-extended-stable-support-drift-");
    writeFixture(rootDir);

    writeJson(path.join(rootDir, "extensions/slack/package.json"), {
      name: "@openclaw/not-slack",
      version: "2026.7.33",
    });
    expect(() =>
      validateExtendedStablePluginPackages({ rootDir, targetVersion: "2026.7.33" }),
    ).toThrow(/package name must be @openclaw\/slack/u);

    writeJson(path.join(rootDir, "extensions/slack/package.json"), {
      name: "@openclaw/slack",
      version: "2026.7.32",
    });
    expect(() =>
      validateExtendedStablePluginPackages({ rootDir, targetVersion: "2026.7.33" }),
    ).toThrow(/version must match root version 2026\.7\.33/u);
  });
});
