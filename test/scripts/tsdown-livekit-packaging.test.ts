// Protect the real LiveKit audio graph's compiler/package dependency boundary.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { resolvePackageBundledPlugins } from "../../scripts/lib/package-bundled-plugins.mts";
import {
  composePackagePlugins,
  type DistributionPackageManifest,
} from "../../src/infra/package-plugin-composition.ts";
import { importFreshModule } from "../../src/plugin-sdk/test-helpers/import-fresh.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
const sdk = "@livekit/rtc-node";
const runtimeNames = [
  "Room",
  "AudioSource",
  "AudioFrame",
  "RoomEvent",
  "TrackKind",
  "AudioStream",
  "LocalAudioTrack",
  "TrackPublishOptions",
  "TrackSource",
];

function readManifest(file: string): DistributionPackageManifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DistributionPackageManifest;
}

describe("selected LiveKit compiler/package boundary", () => {
  it.each(["0", "1"])(
    "keeps the actual audio consumer's lazy native SDK import in package scope (verbose=%s)",
    async (verbose) => {
      vi.stubEnv(DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV, "voice-call");
      vi.stubEnv("OPENCLAW_BUILD_VERBOSE", verbose);
      const { default: configs } = await importFreshModule<typeof import("../../tsdown.config.ts")>(
        import.meta.url,
        `../../tsdown.config.ts?livekit-packaging=${verbose}`,
      );
      const selected = configs.find((config) => {
        const entry = config.entry;
        return (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          entry["extensions/voice-call/runtime-entry"] === "extensions/voice-call/runtime-entry.ts"
        );
      });
      if (!selected) {
        throw new Error("missing selected voice-call runtime graph");
      }
      const neverBundle = selected.deps?.neverBundle;
      if (!Array.isArray(neverBundle)) {
        throw new Error("missing runtime never-bundle policy");
      }
      for (const id of [sdk, `${sdk}/package.json`]) {
        expect(
          neverBundle.some((rule) => (typeof rule === "string" ? rule === id : rule.test(id))),
        ).toBe(true);
      }
      const source = path.resolve("extensions/voice-call/src/providers/livekit-audio.ts");
      const require = createRequire(path.resolve("extensions/voice-call/package.json"));
      const sdkEntry = require.resolve(sdk);
      const sdkBytes = fs.readFileSync(sdkEntry);
      const sdkManifest = JSON.parse(
        fs.readFileSync(path.resolve(path.dirname(sdkEntry), "../package.json"), "utf8"),
      ) as { exports: { ".": { import: { default: string } } } };
      // Node's public import condition keeps the SDK's annotated CJS export scan,
      // unlike the compiler's empty ESM export-star facade in the original build.
      const esmEntry = path.resolve(
        path.dirname(sdkEntry),
        "../",
        sdkManifest.exports["."].import.default,
      );
      expect(fs.readFileSync(esmEntry, "utf8").trim()).toBe("export * from './index.cjs';");
      const annotation = sdkBytes.toString().split("0 && (module.exports = {")[1]?.split("});")[0];
      for (const name of runtimeNames) {
        expect(annotation, `SDK's Node CJS export annotation: ${name}`).toMatch(
          new RegExp(`\\b${name}\\b`, "u"),
        );
      }

      const { bundles } = await build({
        config: false,
        entry: { "livekit-audio": source },
        outDir: tempDirs.make("openclaw-livekit-compiler-"),
        write: false,
        clean: false,
        dts: false,
        logLevel: "silent",
        target: selected.target,
        env: selected.env,
        inputOptions: selected.inputOptions,
        outputOptions: selected.outputOptions,
        deps: {
          ...selected.deps,
          // Compile the plugin-owned graph only; the host SDK has its own build.
          neverBundle: [...neverBundle, /^openclaw(?:\/|$)/u],
        },
      });
      try {
        const chunks = bundles.flatMap((bundle) =>
          bundle.chunks.filter((chunk) => chunk.type === "chunk"),
        );
        const consumer = chunks.find((chunk) => chunk.facadeModuleId === source);
        expect(consumer).toBeDefined();
        expect(consumer?.dynamicImports).toContain(sdk);
        expect(consumer?.code).toMatch(/const rtc = await import\(["']@livekit\/rtc-node["']\);/u);
        for (const name of runtimeNames) {
          expect(consumer?.code, `emitted consumer needs rtc.${name}`).toContain(`rtc.${name}`);
        }
        // No internal RTC facade (empty or otherwise), native asset, or SDK module
        // may replace the bare import. The package owns its platform loader.
        expect(chunks).toHaveLength(1);
        expect(
          chunks.flatMap((chunk) => chunk.moduleIds).some((id) => id.includes("@livekit")),
        ).toBe(false);
        expect(
          bundles.flatMap((bundle) => bundle.chunks).some((chunk) => chunk.type === "asset"),
        ).toBe(false);
        expect(fs.readFileSync(sdkEntry)).toEqual(sdkBytes);
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    },
  );

  it("declares the external native SDK through the maintained selected-plugin composition", () => {
    const root = readManifest("package.json");
    const selected = resolvePackageBundledPlugins(process.cwd(), ["voice-call"]);
    expect(selected).toHaveLength(1);
    const plugin = readManifest("extensions/voice-call/package.json");
    expect(plugin.dependencies?.[sdk]).toBe("1.1.0");
    const composed = composePackagePlugins(
      root,
      selected.map(({ id }) => ({ id, packageJson: plugin })),
    );
    expect(composed.dependencies?.[sdk]).toBe(plugin.dependencies?.[sdk]);
    expect(composed.optionalDependencies?.[sdk]).toBeUndefined();
    expect(composed.files).not.toContain("!dist/extensions/voice-call/**");
    expect(root.dependencies?.[sdk]).toBeUndefined();
  });
});
