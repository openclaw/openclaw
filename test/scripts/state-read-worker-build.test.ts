import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { hasUnjoinedWork, runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import buildConfigs from "../../tsdown.config.ts";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { createScriptTestHarness } from "./test-helpers.js";

const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
const { createTempDir } = createScriptTestHarness();
const handlersModule = "/src/state/openclaw-state-read-handlers.ts";
const registryModule = "/src/state/openclaw-agent-db-registry.read.ts";
const mixedStoreModule = "/src/agents/subagents/registry/subagent-registry.store.worker.ts";
const streamModules = [
  "/src/agents/subagents/registry/subagent-registry.store.restore.worker.ts",
  "/src/transcripts/store-export.worker.ts",
];
const hasModule = (ids: Iterable<string>, ...suffixes: string[]) =>
  [...ids].some((id) => suffixes.some((suffix) => id.endsWith(suffix)));

it("preserves installed native and asset locations when filesystem helpers are bundled", () => {
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));
  const root = fs.realpathSync(createTempDir("openclaw-reader-dependency-build-"));
  // The native dependency and its build run in the shipped reader's process boundary.
  const result = execFileSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "test/scripts/state-read-worker-dependency.test-support.mts",
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
  expect(observed).toMatchObject({
    helper: path.join(packageRoot, "dist/windows-security-helper.exe"),
    bundledNative: observed.originalNative,
    manifestVersion: observed.originalManifestVersion,
    packageErrors: [],
  });
});

it.each([
  ["state/openclaw-state-read.worker", ".js"],
  ["worker/openclaw-state-read.worker", ".mjs"],
])(
  "keeps unrelated handlers out of %s startup",
  async (entryName, extension) => {
    const selected = configs.find(
      (config) =>
        typeof config.entry === "object" &&
        config.entry !== null &&
        Object.hasOwn(config.entry, entryName),
    );
    if (!selected) {
      throw new Error(`Missing state read worker build config: ${entryName}`);
    }
    const buildDirs = createTempDirTracker();
    const outDir = fs.realpathSync(buildDirs.make("openclaw-state-read-build-"));
    let bundles: Awaited<ReturnType<typeof build>>["bundles"] = [];
    let childrenJoined = true;
    try {
      ({ bundles } = await build({
        ...selected,
        config: false,
        outDir,
        dts: false,
        logLevel: "silent",
      }));
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
      const renderedModules = (name: string) =>
        Object.entries(chunks.get(name)?.modules ?? {})
          .filter(([, module]) => module.renderedLength > 0)
          .map(([id]) => id.replaceAll("\\", "/"));
      const staticClosure = (entryFile: string) => {
        const queue = new Set([entryFile]);
        const modules = new Set<string>();
        const dynamicImports = new Set<string>();
        for (const name of queue) {
          const chunk = chunks.get(name);
          if (!chunk) {
            throw new Error(`Missing state read worker chunk: ${name}`);
          }
          renderedModules(name).forEach((id) => modules.add(id));
          chunk.dynamicImports.forEach((specifier) =>
            dynamicImports.add(resolveImport(name, specifier)),
          );
          for (const specifier of chunk.imports) {
            const target = resolveImport(name, specifier);
            if (chunks.has(target)) {
              queue.add(target);
            }
          }
        }
        return { modules, dynamicImports };
      };
      const startup = staticClosure(`${entryName}${extension}`);
      expect(hasModule(startup.modules, handlersModule, mixedStoreModule, ...streamModules)).toBe(
        false,
      );
      expect(hasModule([...chunks.keys()].flatMap(renderedModules), handlersModule)).toBe(true);
      const owners = [
        ...(entryName === "state/openclaw-state-read.worker" ? [registryModule] : []),
        ...streamModules,
      ];
      for (const owner of owners) {
        const targets = [...startup.dynamicImports].filter((name) => {
          const chunk = chunks.get(name);
          return owner === registryModule
            ? hasModule(renderedModules(name), owner)
            : chunk?.facadeModuleId?.replaceAll("\\", "/").endsWith(owner) === true ||
                chunk?.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(owner)) === true;
        });
        expect(targets, owner).toHaveLength(1);
        const loaded = staticClosure(targets[0]!).modules;
        const excluded =
          owner === registryModule
            ? [handlersModule, "/src/state/backup-run-records.kernel.ts"]
            : [
                handlersModule,
                mixedStoreModule,
                ...streamModules.filter((module) => module !== owner),
              ];
        expect(hasModule(loaded, owner), owner).toBe(true);
        expect(hasModule(loaded, ...excluded), owner).toBe(false);
      }
      if (entryName === "worker/openclaw-state-read.worker") {
        const workerUrl = pathToFileURL(path.join(outDir, `${entryName}${extension}`)).href;
        // Each cold process must initialize its selected owner through the emitted continuation.
        for (const mode of ["restore", "export"] as const) {
          childrenJoined = false;
          let code: number;
          try {
            code = await runManagedCommand({
              bin: process.execPath,
              args: [
                "--import",
                path.resolve("scripts/tsx.mjs"),
                path.resolve("test/scripts/state-read-worker-stream.test-support.ts"),
                mode,
                workerUrl,
              ],
              cwd: process.cwd(),
              env: process.env,
              shell: false,
              stdio: ["ignore", "ignore", "inherit"],
              timeoutMs: 60_000,
              timeoutKillGraceMs: 10_000,
              signalKillGraceMs: 10_000,
              abortKillGraceMs: 10_000,
              cleanupDrainTimeoutMs: 5_000,
              timeoutForceKillOnLeaderExit: true,
              requireProcessTreeExit: process.platform !== "win32",
              waitForCleanupRelease: true,
            });
          } catch (error) {
            childrenJoined = !hasUnjoinedWork(error);
            throw error;
          }
          childrenJoined = true;
          // The child asserts the emitted URL and ordered results before it exits.
          expect(code, mode).toBe(0);
        }
      }
    } finally {
      if (childrenJoined) {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
        buildDirs.cleanup();
      } else {
        console.error(`State read worker build retained for unjoined fixture: ${outDir}`);
      }
    }
  },
  180_000,
);
