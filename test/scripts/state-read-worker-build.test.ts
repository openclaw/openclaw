import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import buildConfigs from "../../tsdown.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
const { createTempDir } = createScriptTestHarness();
const handlersModule = "/src/state/openclaw-state-read-handlers.ts";
const registryModule = "/src/state/openclaw-agent-db-registry.read.ts";

describe("state read worker artifacts", () => {
  it("preserves installed native and asset locations when filesystem helpers are bundled", () => {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));
    const root = fs.realpathSync(createTempDir("openclaw-reader-dependency-build-"));
    // The native dependency and its build run in the shipped reader's process boundary.
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        path.resolve("test/scripts/state-read-worker-dependency.test-support.mts"),
        root,
      ],
      { encoding: "utf8" },
    );
    const observed = JSON.parse(result) as {
      helper: string;
      bundledNative: boolean;
      originalNative: boolean;
      manifestVersion: string;
      originalManifestVersion: string;
      packageErrors: string[];
    };
    expect(observed.helper).toBe(path.join(packageRoot, "dist/windows-security-helper.exe"));
    expect(observed.bundledNative).toBe(observed.originalNative);
    expect(observed.manifestVersion).toBe(observed.originalManifestVersion);
    expect(observed.packageErrors).toEqual([]);
  });

  it.each([
    ["state/openclaw-state-read.worker", ".js", handlersModule],
    ["worker/openclaw-state-read.worker", ".mjs", handlersModule],
  ])("keeps unrelated handlers out of %s startup", async (entryName, extension, deferredModule) => {
    const selected = configs.find(
      (config) =>
        typeof config.entry === "object" &&
        config.entry !== null &&
        Object.hasOwn(config.entry, entryName),
    );
    if (!selected) {
      throw new Error(`Missing state read worker build config: ${entryName}`);
    }
    const { bundles } = await build({
      ...selected,
      config: false,
      outDir: fs.realpathSync(createTempDir("openclaw-state-read-build-")),
      dts: false,
      logLevel: "silent",
    });
    try {
      const chunks = new Map(
        bundles.flatMap((bundle) =>
          bundle.chunks
            .filter((chunk) => chunk.type === "chunk")
            .map((chunk) => [chunk.fileName, chunk] as const),
        ),
      );
      const resolveImport = (name: string, specifier: string) =>
        specifier.startsWith(".")
          ? path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
          : specifier;
      const staticClosure = (entryFile: string) => {
        const queue = [entryFile];
        const visited = new Set<string>();
        const modules = new Set<string>();
        const dynamicImports = new Set<string>();
        for (const name of queue) {
          if (visited.has(name)) {
            continue;
          }
          visited.add(name);
          const chunk = chunks.get(name);
          if (!chunk) {
            throw new Error(`Missing state read worker chunk: ${name}`);
          }
          for (const [id, module] of Object.entries(chunk.modules)) {
            if (module.renderedLength > 0) {
              modules.add(id.replaceAll("\\", "/"));
            }
          }
          for (const specifier of chunk.dynamicImports) {
            dynamicImports.add(resolveImport(name, specifier));
          }
          for (const specifier of chunk.imports) {
            const target = resolveImport(name, specifier);
            if (chunks.has(target)) {
              queue.push(target);
            }
          }
        }
        return { modules, dynamicImports };
      };
      const startup = staticClosure(`${entryName}${extension}`);
      expect([...startup.modules].some((id) => id.endsWith(deferredModule))).toBe(false);
      expect(
        [...chunks.values()].some((chunk) =>
          Object.entries(chunk.modules).some(
            ([id, module]) =>
              module.renderedLength > 0 && id.replaceAll("\\", "/").endsWith(deferredModule),
          ),
        ),
      ).toBe(true);
      if (entryName === "state/openclaw-state-read.worker") {
        const registryTargets = [...startup.dynamicImports].filter((name) => {
          const chunk = chunks.get(name);
          return Object.entries(chunk?.modules ?? {}).some(
            ([id, module]) =>
              module.renderedLength > 0 && id.replaceAll("\\", "/").endsWith(registryModule),
          );
        });
        const [registryTarget] = registryTargets;
        if (registryTargets.length !== 1 || registryTarget === undefined) {
          throw new Error(
            `Expected exactly one entry-selected registry reader chunk, found ${registryTargets.length}: ${entryName}`,
          );
        }
        const registry = staticClosure(registryTarget);
        expect([...registry.modules].some((id) => id.endsWith(registryModule))).toBe(true);
        expect(
          [...registry.modules].some(
            (id) =>
              id.endsWith(handlersModule) || id.endsWith("/src/state/backup-run-records.kernel.ts"),
          ),
        ).toBe(false);
      }
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });
});
