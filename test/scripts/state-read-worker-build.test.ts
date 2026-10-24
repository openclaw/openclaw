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
      expect(hasModule(startup.modules, handlersModule)).toBe(false);
      expect(hasModule([...chunks.keys()].flatMap(renderedModules), handlersModule)).toBe(true);
      if (entryName === "state/openclaw-state-read.worker") {
        const registryTargets = [...startup.dynamicImports].filter((name) =>
          hasModule(renderedModules(name), registryModule),
        );
        expect(registryTargets).toHaveLength(1);
        const registry = staticClosure(registryTargets[0]!);
        expect(hasModule(registry.modules, registryModule)).toBe(true);
        expect(
          hasModule(registry.modules, handlersModule, "/src/state/backup-run-records.kernel.ts"),
        ).toBe(false);
      }
      expect(
        [...startup.modules].filter((id) =>
          [mixedStoreModule, ...streamModules].some((module) => id.endsWith(module)),
        ),
      ).toEqual([]);
      for (const streamModule of streamModules) {
        // Manual chunks identify contained modules; facades identify an owner
        // whose rendered body can live in a static dependency.
        const streamTargets = [...startup.dynamicImports].filter((name) => {
          const chunk = chunks.get(name);
          return (
            chunk?.facadeModuleId?.replaceAll("\\", "/").endsWith(streamModule) === true ||
            chunk?.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(streamModule)) === true
          );
        });
        const [streamTarget] = streamTargets;
        if (streamTargets.length !== 1 || streamTarget === undefined) {
          throw new Error(
            `Expected exactly one entry-selected stream chunk for ${streamModule}, found ${streamTargets.length}: ${entryName}`,
          );
        }
        const stream = staticClosure(streamTarget);
        expect(hasModule(stream.modules, streamModule)).toBe(true);
        const unrelatedModules = [
          handlersModule,
          mixedStoreModule,
          ...streamModules.filter((module) => module !== streamModule),
        ];
        expect(
          [...stream.modules].filter((id) =>
            unrelatedModules.some((module) => id.endsWith(module)),
          ),
          `${entryName}: ${streamModule}`,
        ).toEqual([]);
      }
      if (entryName === "worker/openclaw-state-read.worker") {
        const workerUrl = pathToFileURL(path.join(outDir, `${entryName}${extension}`)).href;
        // Each cold process must initialize its selected owner through the emitted continuation.
        for (const mode of ["restore", "export"] as const) {
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let stdoutBytes = 0;
          let stderrBytes = 0;
          const closed = new Set<string>();
          const required = [
            "exit",
            "close",
            "stdout-end",
            "stdout-close",
            "stderr-end",
            "stderr-close",
          ];
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
              stdio: ["ignore", "pipe", "pipe"],
              timeoutMs: 60_000,
              timeoutKillGraceMs: 10_000,
              signalKillGraceMs: 10_000,
              abortKillGraceMs: 10_000,
              cleanupDrainTimeoutMs: 5_000,
              timeoutForceKillOnLeaderExit: true,
              requireProcessTreeExit: process.platform !== "win32",
              waitForCleanupRelease: true,
              onReady(child) {
                child.stdout!.on("data", (bytes: Buffer) => {
                  stdoutBytes += bytes.length;
                  if (stdoutBytes <= 1024 * 1024) {
                    stdout.push(bytes);
                  }
                });
                child.stderr!.on("data", (bytes: Buffer) => {
                  stderrBytes += bytes.length;
                  if (stderrBytes <= 1024 * 1024) {
                    stderr.push(bytes);
                  }
                });
                child.once("exit", () => closed.add("exit"));
                child.once("close", () => closed.add("close"));
                child.stdout!.once("end", () => closed.add("stdout-end"));
                child.stdout!.once("close", () => closed.add("stdout-close"));
                child.stderr!.once("end", () => closed.add("stderr-end"));
                child.stderr!.once("close", () => closed.add("stderr-close"));
              },
            });
          } catch (error) {
            childrenJoined =
              !hasUnjoinedWork(error) && required.every((event) => closed.has(event));
            throw error;
          }
          childrenJoined = required.every((event) => closed.has(event));
          expect(childrenJoined, `${mode}: child and streams joined`).toBe(true);
          expect(stdoutBytes).toBeLessThanOrEqual(1024 * 1024);
          expect(stderrBytes).toBeLessThanOrEqual(1024 * 1024);
          expect(code, Buffer.concat(stderr).toString("utf8")).toBe(0);
          expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toEqual({
            mode,
            workerUrl,
            values:
              mode === "restore"
                ? ["restore-first", "restore-second", "restore-third"]
                : ["first", "second"],
          });
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
