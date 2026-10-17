import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describePackageManifestContract } from "../../plugin-sdk/test-helpers/package-manifest-contract.js";
import { validatePackageExtensionEntriesForInstall } from "../package-entry-resolution.js";
import {
  getPackageManifestMetadata,
  resolvePackageExtensionEntries,
  type PackageManifest,
} from "../package-manifest.js";

type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

function baseline(
  pluginId: string,
  pluginLocalRuntimeDeps?: string[],
  minHostVersionBaseline = "2026.3.22",
): PackageManifestContractParams {
  return { pluginId, pluginLocalRuntimeDeps, minHostVersionBaseline };
}

const packageManifestContractTests: PackageManifestContractParams[] = [
  baseline("buzz", ["nostr-tools"], "2026.7.2"),
  baseline("discord", ["@discordjs/voice", "discord-api-types", "libopus-wasm"]),
  baseline("feishu", ["@larksuiteoapi/node-sdk"]),
  baseline("googlechat", ["google-auth-library"]),
  { pluginId: "imap", pluginLocalRuntimeDeps: ["imapflow", "mailauth", "mailparser"] },
  baseline("irc"),
  baseline("line"),
  { pluginId: "diffs", pluginLocalRuntimeDeps: ["@pierre/diffs"] },
  baseline("matrix", [
    "@matrix-org/matrix-sdk-crypto-nodejs",
    "@matrix-org/matrix-sdk-crypto-wasm",
    "fake-indexeddb",
    "matrix-js-sdk",
    "music-metadata",
  ]),
  baseline("mattermost"),
  baseline("memory-lancedb", ["apache-arrow"]),
  baseline("msteams", ["@azure/identity", "@microsoft/teams.apps"]),
  baseline("nextcloud-talk"),
  baseline("nostr", ["nostr-tools"]),
  baseline("onnx", undefined, "2026.9.6"),
  baseline("synology-chat"),
  baseline("tlon"),
  { pluginId: "tokenjuice", pluginLocalRuntimeDeps: ["tokenjuice"] },
  baseline("twitch"),
  baseline("voice-call"),
  baseline("whatsapp", ["audio-decode", "baileys"]),
  baseline("xiaomi", undefined, "2026.7.2"),
  baseline("zalo"),
  baseline("zalouser"),
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}

it("bundles LanceDB JavaScript while installing matching native bindings per platform", () => {
  const dependencyName = "@lancedb/lancedb";
  const pluginPackagePath = path.resolve(process.cwd(), "extensions/memory-lancedb/package.json");
  const pluginManifest = JSON.parse(
    fs.readFileSync(pluginPackagePath, "utf8"),
  ) as PackageManifest & {
    devDependencies?: Record<string, string>;
  };
  const entry = createRequire(pluginPackagePath).resolve(dependencyName);
  const lancedbManifest = JSON.parse(
    fs.readFileSync(path.resolve(path.dirname(entry), "../package.json"), "utf8"),
  ) as PackageManifest;
  // LanceDB's loader and native ABI must stay at the same version on every supported platform.
  const nativeBindings = Object.fromEntries(
    Object.entries(lancedbManifest.optionalDependencies ?? {}).filter(([name]) =>
      name.startsWith(`${dependencyName}-`),
    ),
  );

  expect(Object.keys(nativeBindings).length).toBeGreaterThan(0);
  expect(pluginManifest.dependencies?.[dependencyName]).toBeUndefined();
  expect(pluginManifest.devDependencies?.[dependencyName]).toBe(lancedbManifest.version);
  expect(pluginManifest.optionalDependencies).toEqual(nativeBindings);
});

describe("plugin package authoring metadata", () => {
  it("exposes the declared discovery and release entrypoints", () => {
    const manifest: PackageManifest = {
      name: "@openclaw/example",
      version: "1.2.3",
      openclaw: {
        extensions: ["./src/index.ts"],
        runtimeExtensions: ["./dist/index.js"],
        setupEntry: "./src/setup.ts",
        runtimeSetupEntry: "./dist/setup.js",
        plugin: {
          id: "example",
          label: "Example",
        },
        compat: {
          pluginApi: ">=1",
          minGatewayVersion: "2026.8.1",
        },
        install: {
          npmSpec: "@openclaw/example",
          minHostVersion: "2026.8.1",
        },
      },
    };

    expect(getPackageManifestMetadata(manifest)).toEqual(manifest.openclaw);
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./src/index.ts"],
    });
  });

  it.each([
    {
      name: "non-object openclaw metadata",
      manifest: { openclaw: "invalid" } as unknown as PackageManifest,
      error: "package.json openclaw must be an object",
    },
    {
      name: "non-array extension metadata",
      manifest: { openclaw: { extensions: "./index.js" } } as unknown as PackageManifest,
      error: "package.json openclaw.extensions must be an array",
    },
    {
      name: "blank extension metadata",
      manifest: { openclaw: { extensions: [" "] } } as PackageManifest,
      error: "package.json openclaw.extensions[0] must be a non-empty string",
    },
  ])("fails fast on $name", ({ manifest, error }) => {
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "invalid",
      entries: [],
      error,
    });
  });

  it("rejects a runtime setup entry without a source setup entry", async () => {
    const result = await validatePackageExtensionEntriesForInstall({
      packageDir: process.cwd(),
      extensions: [],
      manifest: {
        openclaw: {
          extensions: [],
          runtimeSetupEntry: "./dist/setup.js",
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry",
    });
  });
});
