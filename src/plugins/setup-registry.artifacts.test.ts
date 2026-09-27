import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolvePluginSetupRegistry } from "./setup-registry.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

describe("bundled setup code identity", () => {
  it.each(["cjs", "mjs"])(
    "reuses bundled %s setup code while retiring each inventory's callbacks",
    async (extension) => {
      const event = `bundled-setup-evaluation-${extension}`;
      const evaluated = vi.fn();
      process.on(event, evaluated);
      const rootDir = temp.make("bundled-setup-identity-");
      const source = path.join(rootDir, `setup-api.${extension}`);
      const record = {
        id: "bundled-owner",
        origin: "bundled",
        rootDir,
        source,
        setupSource: source,
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        channels: [],
        providers: ["bundled-owner"],
        cliBackends: [],
        skills: [],
        hooks: [],
        setup: { requiresRuntime: true, providers: [{ id: "bundled-owner" }] },
      } satisfies PluginManifestRegistry["plugins"][number];
      const definition = `{
        register(api) {
          const registration = ++registrations;
          api.registerProvider({ id: "bundled-owner", label: "Bundled setup", auth: [],
            resolveConfigApiKey: () => String(registration),
          });
        }
      }`;
      fs.writeFileSync(
        source,
        `process.emit(${JSON.stringify(event)}); let registrations = 0;
        ${extension === "mjs" ? "export default" : "module.exports ="} ${definition};`,
      );
      const manifestRegistry: PluginManifestRegistry = {
        plugins: [record],
        diagnostics: [],
      };
      const caches = Array.from({ length: 3 }, () => createPluginCache());
      try {
        let previous:
          | ReturnType<typeof resolvePluginSetupRegistry>["providers"][number]["provider"]
          | undefined;
        for (const [index, cache] of caches.entries()) {
          const result = withPluginCache(cache, () =>
            resolvePluginSetupRegistry({ manifestRegistry }),
          );
          expect(result.diagnostics).toEqual([]);
          expect(result.providers).toHaveLength(1);
          const current = result.providers[0]!.provider;
          expect(current.resolveConfigApiKey?.({ provider: record.id, env: {} })).toBe(
            String(index + 1),
          );
          if (index > 0) {
            await retirePluginCache(caches[index - 1]!);
            expect(previous).toBeDefined();
            expect(() => previous!.resolveConfigApiKey?.({ provider: record.id, env: {} })).toThrow(
              /reloaded|disabled|retir/,
            );
            expect(current.resolveConfigApiKey?.({ provider: record.id, env: {} })).toBe(
              String(index + 1),
            );
          }
          previous = current;
        }
        expect(evaluated).toHaveBeenCalledOnce();
      } finally {
        await Promise.all(caches.map((cache) => retirePluginCache(cache)));
        process.off(event, evaluated);
      }
    },
  );
});

describe("installed setup artifacts", () => {
  afterEach(clearPluginMetadataLifecycleCaches);

  it.each<{
    artifactDir: string;
    declared: boolean;
    competingDist?: string;
    extension: string;
  }>(
    [
      { artifactDir: ".", declared: true },
      { artifactDir: ".", declared: false },
      { artifactDir: "dist", declared: false },
      { artifactDir: ".", declared: false, competingDist: "setup-api.ts" },
      {
        artifactDir: ".",
        declared: false,
        competingDist: "setup-api.js",
      },
    ].flatMap((entry) =>
      ["cjs", "mjs", "ts"].map((extension) => Object.assign({ extension }, entry)),
    ),
  )(
    "reloads installed $extension $artifactDir setup artifacts (declared: $declared, dist conflict: $competingDist)",
    ({ artifactDir, declared, competingDist, extension }) => {
      const rootDir = temp.make("openclaw-setup-lifecycle-");
      const artifactRoot = path.join(rootDir, artifactDir);
      fs.mkdirSync(artifactRoot, { recursive: true });
      const setupSource = path.join(artifactRoot, `setup-api.${extension}`);
      const dependencyPath = path.join(artifactRoot, "setup-dependency.cjs");
      if (competingDist) {
        fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
        fs.writeFileSync(
          path.join(rootDir, "dist", competingDist),
          'module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "wrong-dist-entry" }); } };\n',
          "utf8",
        );
      }
      const writeSetupArtifact = (version: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          setupSource,
          `${extension === "mjs" ? 'import dependency from "./setup-dependency.cjs"; export default' : "module.exports ="}
          { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "entry-${version}:" + ${extension === "mjs" ? "dependency" : 'require("./setup-dependency.cjs")'} }); } };\n`,
          "utf8",
        );
      };
      const manifestRegistry = {
        plugins: [
          {
            id: "setup-lifecycle",
            rootDir,
            source: setupSource,
            ...(declared ? { setupSource } : {}),
            manifestPath: path.join(rootDir, "openclaw.plugin.json"),
            origin: "global",
            channels: [],
            providers: ["setup-lifecycle"],
            cliBackends: [],
            skills: [],
            hooks: [],
            setup: { requiresRuntime: true, providers: [{ id: "setup-lifecycle" }] },
          },
        ],
        diagnostics: [],
      } satisfies PluginManifestRegistry;

      writeSetupArtifact("before");
      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before",
      );

      writeSetupArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-after:dependency-after",
      );
    },
  );
});
