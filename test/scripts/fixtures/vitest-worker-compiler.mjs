import fs from "node:fs";
import path from "node:path";
import { performance as processPerformance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { hashVitestWorkerArtifact } from "../../../scripts/lib/vitest-worker-artifacts.mts";

// Lifecycle fixtures publish real immutable files without compiling unrelated runtime code.
export function writeWorkerFixtureManifest(directory, inputSources, outputSources) {
  const started = performance.now();
  const inputs = Object.fromEntries(
    Object.entries(inputSources)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([filename, source]) => [filename, hashVitestWorkerArtifact(source)]),
  );
  const outputs = {};
  for (const [name, source] of Object.entries(outputSources).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = path.join(directory, "dist", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    outputs[name] = hashVitestWorkerArtifact(source);
  }
  const manifest = {
    identity: hashVitestWorkerArtifact(JSON.stringify([inputs, outputs])),
    inputs,
    outputs,
    durationMs: performance.now() - started,
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
  return manifest;
}

export async function runWorkerFixtureCompiler(directory, input, receipt) {
  const { runtimeProcessEntrypoints } =
    await import("../../../src/infra/runtime-process-entrypoints.ts");
  const declaration = fileURLToPath(
    new URL("../../../src/infra/runtime-process-entrypoints.ts", import.meta.url),
  );
  const declarationSource = fs.readFileSync(declaration, "utf8");
  const compiledDeclaration = process.versions.bun
    ? new Bun.Transpiler({ loader: "ts" }).transformSync(declarationSource)
    : (await import("node:module")).stripTypeScriptTypes(declarationSource);
  const workerSource = fs.readFileSync(input);
  const manifest = writeWorkerFixtureManifest(
    directory,
    {
      [declaration]: declarationSource,
      [input]: workerSource,
    },
    {
      // Preserve the actual declaration policy and hash the same bytes used for output.
      "infra/runtime-process-entrypoints.js": compiledDeclaration,
      [runtimeProcessEntrypoints.sqliteReadOnly.distWorkerPath]: workerSource,
    },
  );
  fs.appendFileSync(
    receipt,
    JSON.stringify({
      pid: process.pid,
      // A compiler call must not mint a new identity within a reused process.
      processStartTime: processPerformance.timeOrigin,
      isMainThread,
      directory,
      inputs: Object.keys(manifest.inputs).length,
      outputs: Object.keys(manifest.outputs).length,
    }) + "\n",
  );
}

if (import.meta.main) {
  await runWorkerFixtureCompiler(...process.argv.slice(2));
}
