import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
});

describe("bundled channel entry shape guards", () => {
  it("treats missing bundled discovery results as empty", async () => {
    vi.doMock("../../plugins/discovery.js", () => ({
      discoverOpenClawPlugins: () => ({
        candidates: [],
        diagnostics: [],
      }),
    }));
    vi.doMock("../../plugins/manifest-registry.js", () => ({
      loadPluginManifestRegistry: () => ({
        plugins: [],
        diagnostics: [],
      }),
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=missing-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });

  it("keeps channel entrypoints on the narrow channel-core SDK surface", () => {
    const extensionRoot = path.resolve("extensions");
    const offenders: string[] = [];

    for (const extensionId of fs.readdirSync(extensionRoot)) {
      const extensionDir = path.join(extensionRoot, extensionId);
      if (!fs.statSync(extensionDir).isDirectory()) {
        continue;
      }
      for (const relativePath of ["index.ts", "setup-entry.ts"]) {
        const filePath = path.join(extensionDir, relativePath);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const source = fs.readFileSync(filePath, "utf8");
        const usesEntryHelpers =
          source.includes("defineChannelPluginEntry") || source.includes("defineSetupPluginEntry");
        if (!usesEntryHelpers) {
          continue;
        }
        if (source.includes('from "openclaw/plugin-sdk/core"')) {
          offenders.push(path.relative(process.cwd(), filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps channel implementations off the broad core SDK surface", () => {
    const extensionRoot = path.resolve("extensions");
    const offenders: string[] = [];

    for (const extensionId of fs.readdirSync(extensionRoot)) {
      const extensionDir = path.join(extensionRoot, extensionId);
      if (!fs.statSync(extensionDir).isDirectory()) {
        continue;
      }
      for (const relativePath of ["src/channel.ts", "src/plugin.ts"]) {
        const filePath = path.join(extensionDir, relativePath);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const source = fs.readFileSync(filePath, "utf8");
        if (!source.includes("createChatChannelPlugin")) {
          continue;
        }
        if (source.includes('from "openclaw/plugin-sdk/core"')) {
          offenders.push(path.relative(process.cwd(), filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps plugin-sdk channel-core free of chat metadata bootstrap imports", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/channel-core.ts"), "utf8");

    expect(source.includes("../channels/chat-meta.js")).toBe(false);
    expect(source.includes("getChatChannelMeta")).toBe(false);
  });

  it("keeps bundled hot runtime barrels off the broad core SDK surface", () => {
    const offenders = [
      "extensions/googlechat/runtime-api.ts",
      "extensions/irc/src/runtime-api.ts",
      "extensions/matrix/src/runtime-api.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("openclaw/plugin-sdk/core"),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps runtime helper surfaces off bootstrap-registry", () => {
    const offenders = [
      "src/config/markdown-tables.ts",
      "src/config/sessions/group.ts",
      "src/channels/plugins/setup-helpers.ts",
      "src/plugin-sdk/extension-shared.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("bootstrap-registry.js"),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps extension-shared off the broad runtime barrel", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/extension-shared.ts"), "utf8");

    expect(source.includes('from "./runtime.js"')).toBe(false);
  });

  it("keeps nextcloud-talk's private SDK surface off the broad runtime barrel", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/nextcloud-talk.ts"), "utf8");

    expect(source.includes('from "./runtime.js"')).toBe(false);
  });

  it("keeps bundled doctor surfaces off the broad runtime barrel", () => {
    const offenders = [
      "extensions/discord/src/doctor.ts",
      "extensions/matrix/src/doctor.ts",
      "extensions/slack/src/doctor.ts",
      "extensions/telegram/src/doctor.ts",
      "extensions/zalouser/src/doctor.ts",
    ].filter((filePath) =>
      fs
        .readFileSync(path.resolve(filePath), "utf8")
        .includes('from "openclaw/plugin-sdk/runtime"'),
    );

    expect(offenders).toEqual([]);
  });
});
