import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeLobsterPackDefinition,
  type LobsterPackDefinition,
} from "../../packages/gateway-protocol/src/lobsterdex.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { listPluginLobsters, resolvePluginLobsterArtwork } from "./lobster-catalog.js";
import { normalizeManifestLobsterPacks } from "./manifest-lobster-packs.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { finalizePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

vi.unmock("../version.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const source = path.resolve("examples/plugins/lobster-pack");
function fixture() {
  const rootDir = tempDirs.make("openclaw-lobster-pack-");
  fs.cpSync(source, rootDir, { recursive: true });
  fs.chmodSync(rootDir, 0o755);
  fs.writeFileSync(
    path.join(rootDir, "index.js"),
    'throw new Error("metadata must not execute plugin code")',
  );
  const env = { OPENCLAW_STATE_DIR: rootDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
  const readRegistry = () =>
    withPluginCache(createPluginCache(), () => {
      const discovery = discoverConfiguredPluginLoadPaths({ loadPaths: [rootDir], env });
      return loadPluginManifestRegistryCore({ ...discovery, env, installRecords: {} });
    });
  const readSnapshot = () => createPluginMetadataSnapshotFixture(readRegistry());
  const changeDefinition = (change: (definition: LobsterPackDefinition) => void) => {
    const filename = path.join(rootDir, "reef.json");
    const definition = JSON.parse(fs.readFileSync(filename, "utf8"));
    change(definition);
    fs.writeFileSync(filename, JSON.stringify(definition));
  };
  return { rootDir, readRegistry, readSnapshot, changeDefinition };
}

describe("Lobster Pack metadata publication", () => {
  it("discovers the example native pack and publishes original SVG and sprite definitions without executing it", () => {
    const pack = fixture();
    const registry = pack.readRegistry();
    expect(registry.diagnostics).toEqual([]);
    expect(registry.plugins).toHaveLength(1);
    withPluginMetadataSnapshotScope(
      finalizePluginMetadataSnapshot(createPluginMetadataSnapshotFixture(registry)),
      () => {
        const entries = listPluginLobsters();
        expect(entries.map((entry) => entry.id)).toEqual([
          "reef-lobsters/reef/coral",
          "reef-lobsters/reef/tide",
        ]);
        expect(entries[0]).toMatchObject({
          source: "plugin",
          packName: "Reef Lobsters",
          appearance: {
            kind: "svg",
            anchor: { x: 0.5, y: 1 },
            url: expect.stringContaining(
              "/__openclaw__/plugin-lobster-art/reef-lobsters/reef/coral?v=",
            ),
          },
        });
        expect(entries[1]?.appearance).toMatchObject({
          kind: "sprite-atlas",
          animations: { idle: { frames: [0, 1] } },
        });
        expect(resolvePluginLobsterArtwork("reef-lobsters", "reef", "coral")?.data).toBe(
          fs.readFileSync(path.join(pack.rootDir, "assets/coral.svg")).toString("base64"),
        );
      },
    );
  });

  it("retains captured bytes until publication and hides disabled or removed packs", () => {
    const pack = fixture();
    const before = pack.readSnapshot();
    const get = () => withPluginMetadataSnapshotScope(before, listPluginLobsters);
    const oldUrl = get()[0]?.appearance.url;
    const svgPath = path.join(pack.rootDir, "assets/coral.svg");
    const oldSvg = fs.readFileSync(svgPath, "utf8");
    fs.writeFileSync(svgPath, oldSvg.replace("#ff786b", "#0099ff"));
    expect(get()[0]?.appearance.url).toBe(oldUrl);
    expect(
      withPluginMetadataSnapshotScope(
        before,
        () => resolvePluginLobsterArtwork("reef-lobsters", "reef", "coral")?.data,
      ),
    ).toBe(Buffer.from(oldSvg).toString("base64"));
    const after = pack.readSnapshot();
    expect(withPluginMetadataSnapshotScope(after, listPluginLobsters)[0]?.appearance.url).not.toBe(
      oldUrl,
    );
    after.index.plugins[0]!.enabled = false;
    withPluginMetadataSnapshotScope(after, () => {
      expect(listPluginLobsters()).toEqual([]);
      expect(resolvePluginLobsterArtwork("reef-lobsters", "reef", "coral")).toBeUndefined();
    });
    expect(
      withPluginMetadataSnapshotScope(createPluginMetadataSnapshotFixture(), listPluginLobsters),
    ).toEqual([]);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="opacity" values="0;1" dur="1s" repeatCount="indefinite"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:animate attributeName="opacity" values="0;1" dur="1s"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes blink {to {opacity:0}}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" style="animation:blink 1s infinite"/>',
    "x".repeat(64 * 1024 + 1),
  ])("rejects executable, external, or oversized SVG artwork", (svg) => {
    const pack = fixture();
    fs.writeFileSync(path.join(pack.rootDir, "assets/coral.svg"), svg);
    const registry = pack.readRegistry();
    expect(registry.plugins[0]?.lobsterDefinitions).toEqual([]);
    expect(registry.diagnostics.some((entry) => entry.message.includes("self-contained SVG"))).toBe(
      true,
    );
  });

  it("rejects escaped artwork even through a symlink", () => {
    const pack = fixture();
    const outside = tempDirs.make("openclaw-lobster-outside-");
    const asset = path.join(pack.rootDir, "assets/coral.svg");
    fs.renameSync(asset, path.join(outside, "coral.svg"));
    fs.symlinkSync(path.join(outside, "coral.svg"), asset);
    expect(pack.readRegistry().plugins[0]?.lobsterDefinitions).toEqual([]);
  });

  it("rejects a sprite frame outside its PNG atlas", () => {
    const pack = fixture();
    pack.changeDefinition((definition) => {
      const appearance = definition.clawmojis[1]!.appearance;
      if (appearance.kind === "sprite-atlas") {
        appearance.animations.idle.frames = [99];
      }
    });
    const registry = pack.readRegistry();
    expect(registry.plugins[0]?.lobsterDefinitions).toEqual([]);
    expect(registry.diagnostics[0]?.message).toContain("frame index is outside");
  });

  it("rejects truncated or checksum-invalid PNGs", () => {
    const pack = fixture();
    const asset = path.join(pack.rootDir, "assets/tide.png");
    const bytes = fs.readFileSync(asset);
    fs.writeFileSync(asset, bytes.subarray(0, 33));
    expect(pack.readRegistry().diagnostics[0]?.message).toContain("complete PNG");
    bytes[40] = (bytes[40] ?? 0) ^ 1;
    fs.writeFileSync(asset, bytes);
    expect(pack.readRegistry().diagnostics[0]?.message).toContain("checksum");
  });
});

describe("Lobster Pack definition contracts", () => {
  it.each([
    null,
    {},
    [{ id: "../bad", source: "reef.json" }],
    [{ id: "reef", source: "../reef.json" }],
    [{ id: "reef", source: "reef.json", runtime: "index.js" }],
    [
      { id: "reef", source: "reef.json" },
      { id: "reef", source: "other.json" },
    ],
  ])("rejects invalid manifest declarations", (value) => {
    expect(normalizeManifestLobsterPacks(value, "pack").ok).toBe(false);
  });
  it("rejects duplicate characters, unknown fields and executable appearance definitions", () => {
    const value = JSON.parse(fs.readFileSync(path.join(source, "reef.json"), "utf8"));
    expect(() => normalizeLobsterPackDefinition({ ...value, schemaVersion: 2 })).toThrow(
      "schemaVersion",
    );
    expect(() =>
      normalizeLobsterPackDefinition({
        ...value,
        clawmojis: [value.clawmojis[0], value.clawmojis[0]],
      }),
    ).toThrow("unique");
    value.clawmojis[0].appearance.script = "alert(1)";
    expect(() => normalizeLobsterPackDefinition(value)).toThrow("unsupported fields");
  });
});
