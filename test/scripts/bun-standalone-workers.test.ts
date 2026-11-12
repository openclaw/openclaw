import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { afterEach, expect, it } from "vitest";
import {
  discoverStandaloneWorkers,
  prepareStandaloneWorkers,
} from "../../scripts/lib/bun-standalone-workers.mjs";
import { runtimeProcessBuildEntries } from "../../scripts/lib/runtime-process-build-entries.mts";
import { createStandaloneRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(files: Record<string, string>) {
  const runtimeRoot = tempDirs.make("openclaw-standalone-workers-");
  writeFixtureFiles(runtimeRoot, files);
  return runtimeRoot;
}

it("admits Knowledge's package-declared workers into the standalone and source build graphs", () => {
  const packageRoot = new URL("../../extensions/knowledge/", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL("package.json", packageRoot), "utf8")) as {
    openclaw: { build: { workerEntries: string[] } };
  };
  const outputs = manifest.openclaw.build.workerEntries.map(
    (entry) => `dist/extensions/knowledge/${entry.replace(/^\.\//u, "").replace(/\.ts$/u, ".js")}`,
  );
  const runtimeRoot = fixture(Object.fromEntries(outputs.map((entry) => [entry, "export {};\n"])));
  const declarations = Object.fromEntries(
    Object.entries(
      createStandaloneRuntimeProcessEntrypoints(import.meta.url, ["knowledge"]),
    ).filter(([name]) => name.startsWith("plugin:")),
  );
  expect(discoverStandaloneWorkers({ runtimeRoot, runtimeEntrypoints: declarations })).toEqual(
    outputs.toSorted(),
  );
  for (const entry of manifest.openclaw.build.workerEntries) {
    const output = `extensions/knowledge/${entry.replace(/^\.\//u, "").replace(/\.ts$/u, "")}`;
    expect(runtimeProcessBuildEntries[output]).toBe(fileURLToPath(new URL(entry, packageRoot)));
  }
});

it("embeds only declared targets, including names without worker suffixes", () => {
  const runtimeRoot = fixture({
    "dist/process/relay.js": "",
    "dist/doctor-inspection.worker.js": "",
    "dist/undeclared.worker.js": "",
    "node-compile-cache.mjs": "",
  });
  expect(
    discoverStandaloneWorkers({
      runtimeRoot,
      runtimeEntrypoints: {
        relay: { distWorkerPath: "process/relay.js" },
        inspection: { distWorkerPath: "doctor-inspection.worker.js" },
        cache: { distWorkerPath: "../node-compile-cache.mjs" },
      },
    }),
  ).toEqual([
    "dist/doctor-inspection.worker.js",
    "dist/process/relay.js",
    "node-compile-cache.mjs",
  ]);
});

it("refuses missing declared outputs before producing an incomplete image", () => {
  expect(() =>
    discoverStandaloneWorkers({
      runtimeRoot: fixture({}),
      runtimeEntrypoints: { missing: { distWorkerPath: "commands/doctor.worker.js" } },
    }),
  ).toThrow("Missing standalone worker outputs: dist/commands/doctor.worker.js");
});

it("requires every declared worker and child entry in the compiler outputs", () => {
  const runtimeRoot = fixture({});
  const outputRoot = path.join(runtimeRoot, "build");
  const prepared = prepareStandaloneWorkers({
    runtimeRoot,
    outputRoot,
    runtimeBootstrap: path.join(outputRoot, "bootstrap.mjs"),
    workerEntries: ["dist/commands/doctor.worker.js", "dist/recovery.mjs"],
  });
  const doctor = path.join(outputRoot, "modules/standalone-workers/dist/commands/doctor.worker.js");
  const recovery = path.join(outputRoot, "modules/standalone-workers/dist/recovery.js");
  expect(() => prepared.validateOutputs([doctor])).toThrow(
    "Missing embedded standalone worker outputs: dist/recovery.mjs",
  );
  expect(() => prepared.validateOutputs([doctor, recovery])).not.toThrow();
});

it("routes declared physical worker paths through their embedded bootstrap", () => {
  const runtimeRoot = fixture({ "dist/commands/doctor.worker.js": "export {};" });
  const outputRoot = path.join(runtimeRoot, "build");
  fs.mkdirSync(outputRoot);
  const bootstrap = path.join(outputRoot, "bootstrap.mjs");
  const prepared = prepareStandaloneWorkers({
    runtimeRoot,
    outputRoot,
    runtimeBootstrap: bootstrap,
    workerEntries: ["dist/commands/doctor.worker.js"],
    sourceWorkerAliases: { "/typed/doctor.worker.ts": "dist/commands/doctor.worker.js" },
  });
  expect(fs.readFileSync(prepared.entrypoints[0]!, "utf8")).toBe(
    `import ${JSON.stringify(bootstrap)};\nawait import(${JSON.stringify(path.join(runtimeRoot, "dist/commands/doctor.worker.js"))});\n`,
  );
  class NativeWorker {
    constructor(readonly filename: string | URL) {}
  }
  const exported: { exports?: { Worker: typeof NativeWorker } } = {};
  runInNewContext(fs.readFileSync(prepared.workerThreadsShim, "utf8"), {
    URL,
    process: { execPath: path.join(runtimeRoot, "..", "openclaw") },
    module: exported,
    require: (specifier: string) =>
      specifier === "node:worker_threads"
        ? { Worker: NativeWorker }
        : process.getBuiltinModule(specifier),
  });
  // The shim resolves its sidecar relative to the executable, independently of this fixture root.
  const physical = path.join(runtimeRoot, "..", "runtime", "dist/commands/doctor.worker.js");
  expect(new exported.exports!.Worker(physical).filename.toString()).toBe(
    "file:///$bunfs/root/standalone-workers/dist/commands/doctor.worker.js",
  );
  expect(new exported.exports!.Worker("/typed/doctor.worker.ts").filename.toString()).toBe(
    "file:///$bunfs/root/standalone-workers/dist/commands/doctor.worker.js",
  );
  expect(() =>
    prepared.updateSourceWorkerAliases({ "/typed/unknown.ts": "dist/unknown.js" }),
  ).toThrow("Unknown standalone worker alias target");
  expect(
    () => new exported.exports!.Worker(path.join(runtimeRoot, "..", "runtime", "dist/missing.js")),
  ).toThrow("Undeclared standalone worker: dist/missing.js");
  const source = 'import { Worker } from "node:worker_threads"; new Worker(target);';
  const rewritten = prepared.rewriteWorkerImports(
    "fixture.mjs",
    source,
    parse(source, { ecmaVersion: "latest", sourceType: "module" }),
  );
  expect(rewritten).toContain(JSON.stringify(prepared.workerThreadsShim));
});
