import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { captureEnv } from "../test-utils/env.js";

vi.mock("./bundled-dir.js", () => ({
  isPluginInPackageBundledRoots: vi.fn(() => false),
  resolveBundledPluginsDir: vi.fn(),
  resolveSourceCheckoutDependencyDiagnostic: vi.fn(() => null),
}));

import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { listChannelCatalogEntries } from "./channel-catalog-registry.js";
import type { PluginManifest, PluginPackageChannel } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const tempDirs: string[] = [];
const originalEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
]);

afterEach(() => {
  originalEnv.restore();
  cleanupTempDirs(tempDirs);
  clearPluginMetadataLifecycleCaches();
  vi.restoreAllMocks();
  vi.mocked(resolveBundledPluginsDir).mockReset();
});

function writePackage(packagePath: string, channel: PluginPackageChannel) {
  writeJsonFile(packagePath, { name: "@openclaw/matrix", openclaw: { channel } });
}

function fixture(channel: PluginPackageChannel) {
  const extensionsRoot = path.join(makeTempRepoRoot(tempDirs, "bpcm-"), "dist", "extensions");
  const pluginRoot = path.join(extensionsRoot, "matrix");
  const packagePath = path.join(pluginRoot, "package.json");
  writePackage(packagePath, channel);
  writeJsonFile(path.join(pluginRoot, "openclaw.plugin.json"), {
    id: "matrix",
    configSchema: { type: "object" },
    channels: ["matrix"],
  });
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n", "utf8");
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = extensionsRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(extensionsRoot);
  return packagePath;
}

const readMatrix = () =>
  listChannelCatalogEntries({ origin: "bundled" }).find((entry) => entry.channel.id === "matrix")
    ?.channel;

describe("bundled package channel metadata", () => {
  it("reads doctor capabilities from the resolved bundled plugin dir", () => {
    fixture({
      id: "matrix",
      label: "Matrix",
      docsPath: "/channels/matrix",
      doctorCapabilities: {
        dmAllowFromMode: "nestedOnly",
        groupModel: "sender",
        groupAllowFromFallbackToAllowFrom: false,
        warnOnEmptyGroupSenderAllowlist: true,
      },
    });
    expect(readMatrix()?.doctorCapabilities).toEqual({
      dmAllowFromMode: "nestedOnly",
      groupModel: "sender",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: true,
    });
  });

  it("reflects package channel metadata edits after the metadata lifecycle is cleared", () => {
    const packagePath = fixture({ id: "matrix", label: "Before" });
    expect(readMatrix()?.label).toBe("Before");
    writePackage(packagePath, { id: "matrix", label: "After" });
    clearPluginMetadataLifecycleCaches();
    expect(readMatrix()?.label).toBe("After");
  });
});

it("keeps bundled channel schemas single-sourced from the generated metadata", async () => {
  const { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } =
    await import("../config/bundled-channel-config-metadata.generated.js");
  const { listGitTrackedFiles } = await import("../test-utils/repo-files.js");
  const { pluginTestRepoRoot } = await import("./generated-plugin-test-helpers.js");
  const tracked =
    listGitTrackedFiles({
      repoRoot: pluginTestRepoRoot,
      pathspecs: "extensions/*/openclaw.plugin.json",
    }) ?? [];
  expect(tracked.length).toBeGreaterThan(0);
  const generatedChannelIds = new Set(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => entry.channelId),
  );
  const emptyStub = { type: "object", additionalProperties: false, properties: {} };
  for (const file of tracked) {
    const dirName = file.split("/")[1] ?? file;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginTestRepoRoot, file), "utf8"),
    ) as PluginManifest;
    const channelIds = (manifest.channels ?? []).filter((id) => generatedChannelIds.has(id));
    if (channelIds.length === 0) {
      continue;
    }
    for (const channelId of channelIds) {
      // A manifest copy silently overrides the zod-derived generated schema in
      // config validation and rots (stale copies rejected valid keys; see #131292).
      expect(
        manifest.channelConfigs?.[channelId]?.schema,
        `extensions/${dirName}: delete channelConfigs.${channelId}.schema — the zod-derived generated bundled channel metadata is the single schema source`,
      ).toBeUndefined();
    }
    // WhatsApp has a distinct plugin-entry config surface.
    if ((manifest.id ?? dirName) !== "whatsapp") {
      expect(
        manifest.configSchema,
        `extensions/${dirName}: channel plugins carry no plugin-entry config; keep configSchema as the empty stub or add a named exception here with its reason`,
      ).toEqual(emptyStub);
    }
  }
});
