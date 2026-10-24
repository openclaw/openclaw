import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { auditCompilerComparison } from "../../scripts/audit-compiler-comparison.mts";
import { networkFixture } from "./compiler-comparison-network.fixtures.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const error = "input.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n";
type Outcome = { exitCode: number; stdout: string };
const passed = { exitCode: 0, stdout: "" };
const failed = { exitCode: 1, stdout: error };

function fixture(outcomes: { pinned: Outcome; candidate: Outcome; reference: Outcome }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-canary-"));
  temporary.push(directory);
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const core = { name: "core", config: "tsconfig.json" };
  const canary = {
    name: "canary-negative",
    config: "canary/tsconfig.json",
    kind: "control",
    expectedCodes: [2322],
  };
  const compilers = ["pinned", "candidate", "reference"] as const;
  const graphs = [core, canary];
  const parity = graphs.map((graph) => {
    const config = JSON.stringify({ compilerOptions: { noEmit: true } });
    const files = "/libs/lib.es2022.d.ts\n";
    const proofs = Object.fromEntries(
      compilers.map((compiler) => {
        fs.writeFileSync(path.join(directory, graph.name + "-" + compiler + "-config.txt"), config);
        fs.writeFileSync(path.join(directory, graph.name + "-" + compiler + "-files.txt"), files);
        return [compiler, { config: { sha256: hash(config) }, files: { sha256: hash(files) } }];
      }),
    );
    return { graph: graph.name, proofs };
  });
  const rows = graphs.flatMap((graph) =>
    (graph === core ? ["incremental-cold"] : ["nonincremental", "single-threaded"]).flatMap(
      (mode) =>
        compilers.map((compiler) => {
          const outcome = graph === core ? passed : outcomes[compiler];
          const id = [graph.name, mode, compiler, 1].join("-");
          fs.writeFileSync(path.join(directory, id + ".stdout"), outcome.stdout);
          fs.writeFileSync(path.join(directory, id + ".stderr"), "");
          return {
            graph: graph.name,
            config: graph.config,
            mode,
            compiler,
            iteration: 1,
            flags: [
              "-p",
              graph.config,
              "--noEmit",
              "--declaration",
              "false",
              "--pretty",
              "false",
              "--incremental",
              mode === "incremental-cold" ? "true" : "false",
              ...(mode === "incremental-cold"
                ? ["--tsBuildInfoFile", "/cache/project.tsbuildinfo"]
                : []),
              ...(mode === "single-threaded" ? ["--singleThreaded"] : []),
            ],
            ...outcome,
            diagnosticSha256: hash(outcome.stdout),
            stdoutBytes: Buffer.byteLength(outcome.stdout),
            stderrBytes: 0,
            wallSeconds: 1,
            userSeconds: 1,
            sysSeconds: 0,
            peakRssKiB: 1024,
          };
        }),
    ),
  );
  const metadata = {
    sourceHead: "a".repeat(40),
    repeats: 1,
    group: 0,
    groups: 1,
    binarySha256: { pinned: "a".repeat(64), candidate: "b".repeat(64), reference: "c".repeat(64) },
    libraryManifest: [{ name: "lib.es2022.d.ts", sha256: "d".repeat(64) }],
    canaries: [canary],
    expectedSamples: rows.map((row) =>
      [row.graph, row.mode, row.compiler, row.iteration].join("-"),
    ),
  };
  write("metadata.json", metadata);
  write("network-isolation.json", networkFixture());
  write("inventory.json", { inventory: [core], graphs: [core], group: 0, groups: 1 });
  write("input-parity.json", parity);
  write("measurements.json", rows);
  return { directory, write, rows, metadata };
}

it("qualifies expected negative canaries without calling their typechecks passing", () => {
  const evidence = fixture({ pinned: failed, candidate: failed, reference: failed });
  const result = auditCompilerComparison(evidence.directory);
  expect(result.typecheckPassed).toBe(true);
  expect(result.canariesPassed).toBe(true);
  expect(result.qualificationPassed).toBe(true);
  expect(result.comparisons.filter((row) => row.canary).every((row) => !row.typecheckPassed)).toBe(
    true,
  );
});

it("rejects three equally empty results when a negative control should diagnose an error", () => {
  const evidence = fixture({ pinned: passed, candidate: passed, reference: passed });
  const result = auditCompilerComparison(evidence.directory);
  expect(result.typecheckPassed).toBe(true);
  expect(result.canariesPassed).toBe(false);
  expect(result.qualificationPassed).toBe(false);
});

it("rejects a candidate false negative against both upstream baselines", () => {
  const evidence = fixture({ pinned: failed, candidate: passed, reference: failed });
  const result = auditCompilerComparison(evidence.directory);
  expect(result.status).toBe("divergent");
  expect(result.canariesPassed).toBe(false);
});

it("does not lose an entirely missing canary batch", () => {
  const evidence = fixture({ pinned: failed, candidate: failed, reference: failed });
  evidence.write(
    "measurements.json",
    evidence.rows.filter((row) => row.graph === "core"),
  );
  const result = auditCompilerComparison(evidence.directory);
  expect(result.status).toBe("incomplete");
  expect(result.canariesPassed).toBe(false);
  expect(result.qualificationPassed).toBe(false);
});
