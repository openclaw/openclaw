import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installOpenClawPluginSdkNativeResolver,
  resetOpenClawPluginSdkNativeResolverForTest,
} from "./plugin-sdk-native-resolver.js";

afterEach(() => {
  resetOpenClawPluginSdkNativeResolverForTest();
});

function writeJsonFile(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFakeOpenClawPackage(root: string): { distRoot: string; loaderModulePath: string } {
  writeJsonFile(path.join(root, "package.json"), {
    name: "openclaw",
    type: "module",
    bin: {
      openclaw: "./openclaw.mjs",
    },
    exports: {
      "./cli-entry": "./dist/cli-entry.js",
      "./plugin-sdk": "./dist/plugin-sdk/root-alias.cjs",
      "./plugin-sdk/discord": "./dist/plugin-sdk/discord.js",
    },
  });
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  const distRoot = path.join(root, "dist");
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  fs.mkdirSync(pluginSdkDir, { recursive: true });
  fs.writeFileSync(path.join(pluginSdkDir, "root-alias.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginSdkDir, "discord.js"),
    [
      'export const sendDiscordComponentMessage = () => "component";',
      'export const sendPollDiscord = () => "poll";',
      "",
    ].join("\n"),
    "utf8",
  );
  const loaderModulePath = path.join(distRoot, "plugins", "loader.js");
  fs.mkdirSync(path.dirname(loaderModulePath), { recursive: true });
  fs.writeFileSync(loaderModulePath, "export default {};\n", "utf8");
  return { distRoot, loaderModulePath };
}

describe("installOpenClawPluginSdkNativeResolver", () => {
  it("lets built external plugins resolve OpenClaw SDK subpaths with createRequire", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-resolver-"));
    const { distRoot, loaderModulePath } = writeFakeOpenClawPackage(root);
    const externalPluginEntry = path.join(root, "external-plugin", "dist", "runtime-api.js");
    fs.mkdirSync(path.dirname(externalPluginEntry), { recursive: true });
    fs.writeFileSync(externalPluginEntry, "export default {};\n", "utf8");

    const distMode = fs.statSync(distRoot).mode;
    if (process.platform !== "win32") {
      fs.chmodSync(distRoot, 0o555);
    }

    try {
      const installedAliases = installOpenClawPluginSdkNativeResolver({
        modulePath: loaderModulePath,
        pluginSdkResolution: "dist",
      });

      expect(installedAliases).toContain("openclaw/plugin-sdk/discord");
      expect(fs.existsSync(path.join(distRoot, "extensions"))).toBe(false);
      const requireFromPlugin = createRequire(externalPluginEntry);
      expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/discord"))).toBe(
        fs.realpathSync(path.join(distRoot, "plugin-sdk", "discord.js")),
      );
      const sdk = requireFromPlugin("openclaw/plugin-sdk/discord") as {
        sendDiscordComponentMessage?: () => string;
        sendPollDiscord?: () => string;
      };

      expect(sdk.sendDiscordComponentMessage?.()).toBe("component");
      expect(sdk.sendPollDiscord?.()).toBe("poll");
      expect(() => requireFromPlugin.resolve("openclaw/not-plugin-sdk/discord")).toThrow();
    } finally {
      if (process.platform !== "win32") {
        fs.chmodSync(distRoot, distMode);
      }
    }
  });
});
