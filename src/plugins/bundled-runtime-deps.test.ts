import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

describe("bundled plugin runtime dependencies", () => {
  function expectPluginOwnsRuntimeDep(pluginPath: string, dependencyName: string) {
    const rootManifest = readJson<PackageManifest>("package.json");
    const pluginManifest = readJson<PackageManifest>(pluginPath);
    const pluginSpec = pluginManifest.dependencies?.[dependencyName];
    const rootSpec = rootManifest.dependencies?.[dependencyName];

    expect(pluginSpec).toBeTruthy();
    expect(rootSpec).toBeUndefined();
  }

  it("keeps bundled Feishu runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/feishu/package.json", "@larksuiteoapi/node-sdk");
  });

  it("keeps memory-lancedb runtime deps plugin-local so packaged installs fetch them on demand", () => {
    expectPluginOwnsRuntimeDep("extensions/memory-lancedb/package.json", "@lancedb/lancedb");
  });

  it("keeps bundled Discord runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/discord/package.json", "@buape/carbon");
  });

  it("keeps bundled Slack runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/slack/package.json", "@slack/bolt");
  });

  it("keeps bundled Telegram runtime deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/telegram/package.json", "grammy");
  });

  it("keeps WhatsApp runtime deps plugin-local so packaged installs fetch them on demand", () => {
    expectPluginOwnsRuntimeDep("extensions/whatsapp/package.json", "@whiskeysockets/baileys");
  });

  it("keeps WhatsApp image helper deps plugin-local so bundled builds resolve Baileys peers", () => {
    expectPluginOwnsRuntimeDep("extensions/whatsapp/package.json", "jimp");
  });

  it("keeps bundled proxy-agent deps plugin-local instead of mirroring them into the root package", () => {
    expectPluginOwnsRuntimeDep("extensions/discord/package.json", "https-proxy-agent");
  });
});
