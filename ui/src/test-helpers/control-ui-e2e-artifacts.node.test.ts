// @vitest-environment node
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";

const tempDirs: string[] = [];
const artifactNames = ["state.png", "proof.webm", "report.json"];
const readArtifacts = (directory: string) =>
  artifactNames.map((name) => readFileSync(path.join(directory, name), "utf8"));
// Vite rewrites asset-style new URL expressions under the ordinary UI test runner.
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(path.join(sourceDir, "control-ui-e2e-artifacts.ts")).href;

async function captureInWorker(parent: string, contents: string): Promise<string> {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
             const { writeFileSync } = require("node:fs");
             const path = require("node:path");
             import(workerData.moduleUrl).then(({ createControlUiE2eArtifactDir }) => {
               const directory = createControlUiE2eArtifactDir("same-scenario", workerData.parent);
               for (const name of workerData.names) {
                 writeFileSync(path.join(directory, name), workerData.contents);
               }
               parentPort.postMessage(directory);
             });`,
    { eval: true, workerData: { moduleUrl, parent, contents, names: artifactNames } },
  );
  let directory: string | undefined;
  worker.once("message", (value: string) => {
    directory = value;
  });
  const [code] = await once(worker, "exit");
  if (code !== 0 || typeof directory !== "string") {
    throw new Error(`Capture worker did not finish with a directory (exit ${code})`);
  }
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs(tempDirs);
});

it("allocates independently in concurrent workers sharing the same parent and scope", async () => {
  const parent = makeTempDir(tempDirs, "control-ui-proof-workers-");
  const previous = path.join(parent, "same-scenario");
  mkdirSync(previous);
  for (const name of artifactNames) {
    writeFileSync(path.join(previous, name), `old:${name}`);
  }
  const outputs = await Promise.all(
    ["first", "second"].map((contents) => captureInWorker(parent, contents)),
  );
  expect(new Set(outputs).size).toBe(2);
  expect(readArtifacts(previous)).toEqual(artifactNames.map((name) => `old:${name}`));
  for (const [index, directory] of outputs.entries()) {
    expect(readArtifacts(directory)).toEqual(artifactNames.map(() => ["first", "second"][index]));
  }
});

it.each([
  ["configured", false],
  ["configured", true],
  [undefined, false],
  ["   ", false],
  [undefined, true],
] as const)("allocates without enabling capture (root %s, explicit %s)", (root, explicit) => {
  const configured = root === "configured" ? makeTempDir(tempDirs, "proof-root-") : undefined;
  const parent = explicit ? makeTempDir(tempDirs, "proof-explicit-") : undefined;
  const rawRoot = configured ? `  ${configured}  ` : root;
  vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", rawRoot);
  vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "0");
  const directory = createControlUiE2eArtifactDir("allocator-regression", parent);
  // Track only the exclusive child, never the repository evidence parent.
  if (!parent && !configured) {
    tempDirs.push(directory);
  }
  expect(path.dirname(directory)).toBe(
    parent ?? configured ?? path.resolve(sourceDir, "../../../.artifacts/control-ui-e2e"),
  );
  if (parent) {
    expect(readdirSync(parent)).toEqual([path.basename(directory)]);
  }
  expect(process.env.OPENCLAW_CAPTURE_UI_PROOF).toBe("0");
  expect(process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR).toBe(rawRoot);
});
