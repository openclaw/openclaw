import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompilerComparison } from "../../scripts/audit-compiler-comparison.mts";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const diagnostic =
  "src/commands/backup-record.ts(39,48): error TS2345: Argument of type 'string' is not assignable to parameter of type '\"failed\" | \"ok\"'.\n";

function fixture(
  outcomes: Record<string, { exitCode: number; stdout: string }> = {
    pinned: { exitCode: 0, stdout: "" },
    candidate: { exitCode: 0, stdout: "" },
  },
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-comparison-"));
  temporary.push(directory);
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const graphs = [{ name: "core", config: "tsconfig.json" }];
  write("metadata.json", {
    sourceHead: "a".repeat(40),
    repeats: 2,
    group: 0,
    groups: 1,
    binarySha256: {
      pinned: "a".repeat(64),
      candidate: "b".repeat(64),
      reference: "c".repeat(64),
    },
    libraryManifest: [
      { name: "lib.d.ts", sha256: "e".repeat(64) },
      { name: "lib.es2022.d.ts", sha256: "d".repeat(64) },
    ],
  });
  write("inventory.json", { inventory: graphs, graphs, group: 0, groups: 1 });
  const config = JSON.stringify({
    compilerOptions: { noEmit: true, declaration: false, pretty: false, incremental: true },
  });
  const proofs = {
    pinned: {
      config: { sha256: hash(config) },
      files: { sha256: hash("/libs/lib.es2022.d.ts\n") },
    },
    candidate: {
      config: { sha256: hash(config) },
      files: { sha256: hash("/libs/lib.es2022.d.ts\n") },
    },
  };
  for (const compiler of ["pinned", "candidate"]) {
    fs.writeFileSync(path.join(directory, `core-${compiler}-config.txt`), config);
    fs.writeFileSync(path.join(directory, `core-${compiler}-files.txt`), "/libs/lib.es2022.d.ts\n");
  }
  const rows = Object.entries(outcomes).flatMap(([compiler, outcome]) =>
    [1, 2].map((iteration) => {
      const id = `core-incremental-cold-${compiler}-${iteration}`;
      fs.writeFileSync(path.join(directory, `${id}.stdout`), outcome.stdout);
      fs.writeFileSync(path.join(directory, `${id}.stderr`), "");
      return {
        graph: "core",
        config: "tsconfig.json",
        mode: "incremental-cold",
        compiler,
        iteration,
        flags: [
          "-p",
          "tsconfig.json",
          "--noEmit",
          "--declaration",
          "false",
          "--pretty",
          "false",
          "--incremental",
          "true",
          "--tsBuildInfoFile",
          "/cache/project.tsbuildinfo",
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
  );
  const save = () => {
    write("input-parity.json", [{ graph: "core", equal: true, proofs }]);
    write("measurements.json", rows);
  };
  save();
  const row = (index: number) => {
    const value = rows[index];
    assert(value);
    return value;
  };
  return { directory, rows, row, proofs, save, write };
}

describe("compiler comparison artifact audit", () => {
  it("accepts complete passing samples and reports absent reference coverage", () => {
    const result = auditCompilerComparison(fixture().directory);
    expect(result.status).toBe("equivalent");
    expect(result.typecheckPassed).toBe(true);
    expect(result.comparisons[0]?.referenceOutcomeMatches).toBeNull();
    expect(result.scope.graphs).toEqual([{ name: "core", config: "tsconfig.json" }]);
  });

  it("reports the observed version divergence without calling reference agreement adoption proof", () => {
    const result = auditCompilerComparison(
      fixture({
        pinned: { exitCode: 0, stdout: "" },
        candidate: { exitCode: 1, stdout: diagnostic },
        reference: { exitCode: 1, stdout: diagnostic },
      }).directory,
    );
    expect(result.status).toBe("divergent");
    expect(result.typecheckPassed).toBe(false);
    expect(result.comparisons[0]?.referenceOutcomeMatches).toBe(true);
  });

  it("distinguishes identical failed typechecks from passing proof", () => {
    const result = auditCompilerComparison(
      fixture({
        pinned: { exitCode: 2, stdout: diagnostic },
        candidate: { exitCode: 2, stdout: diagnostic },
      }).directory,
    );
    expect(result.status).toBe("equivalent");
    expect(result.typecheckPassed).toBe(false);
  });

  it("requires every iteration and the primary graph even when no rows remain", () => {
    const evidence = fixture();
    evidence.rows.pop();
    evidence.save();
    expect(auditCompilerComparison(evidence.directory).status).toBe("incomplete");
    evidence.rows.splice(0);
    evidence.save();
    expect(auditCompilerComparison(evidence.directory).missing).toHaveLength(2);
  });

  it.each([
    ["duplicate sample", (value: ReturnType<typeof fixture>) => value.rows.push(value.row(0))],
    [
      "forged diagnostic hash",
      (value: ReturnType<typeof fixture>) => {
        value.row(0).diagnosticSha256 = "e".repeat(64);
      },
    ],
    [
      "unexpected exit",
      (value: ReturnType<typeof fixture>) => {
        value.row(0).exitCode = 137;
      },
    ],
    [
      "nonfinite metric",
      (value: ReturnType<typeof fixture>) => {
        value.row(0).wallSeconds = Number.NaN;
      },
    ],
    [
      "different flags",
      (value: ReturnType<typeof fixture>) => {
        value.row(2).flags.push("--skipLibCheck");
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const evidence = fixture();
    mutate(evidence);
    evidence.save();
    expect(() => auditCompilerComparison(evidence.directory)).toThrow();
  });

  it("compares input bytes instead of trusting the collector's equal flag", () => {
    const evidence = fixture();
    const different = "/libs/lib.es2022.d.ts\n/work/skipped.ts\n";
    fs.writeFileSync(path.join(evidence.directory, "core-candidate-files.txt"), different);
    evidence.proofs.candidate.files.sha256 = hash(different);
    evidence.save();
    const result = auditCompilerComparison(evidence.directory);
    expect(result.status).toBe("divergent");
    expect(result.comparisons[0]?.inputEqual).toBe(false);
  });

  it("rejects matching invocations or expanded configuration that disable typechecking", () => {
    const evidence = fixture();
    for (const row of evidence.rows) {
      row.flags.push("--noCheck");
    }
    evidence.save();
    expect(() => auditCompilerComparison(evidence.directory)).toThrow(
      "Invalid checking invocation",
    );
    for (const row of evidence.rows) {
      row.flags.pop();
    }
    const config = JSON.stringify({ compilerOptions: { noCheck: true } });
    for (const compiler of ["pinned", "candidate"] as const) {
      fs.writeFileSync(path.join(evidence.directory, `core-${compiler}-config.txt`), config);
      evidence.proofs[compiler].config.sha256 = hash(config);
    }
    evidence.save();
    expect(() => auditCompilerComparison(evidence.directory)).toThrow("disables typechecking");
  });

  it("reports an unstable reference separately from matching primary compilers", () => {
    const evidence = fixture({
      pinned: { exitCode: 0, stdout: "" },
      candidate: { exitCode: 0, stdout: "" },
      reference: { exitCode: 0, stdout: "" },
    });
    const row = evidence.row(5);
    row.exitCode = 1;
    row.diagnosticSha256 = hash(diagnostic);
    row.stdoutBytes = Buffer.byteLength(diagnostic);
    fs.writeFileSync(
      path.join(evidence.directory, "core-incremental-cold-reference-2.stdout"),
      diagnostic,
    );
    evidence.save();
    const result = auditCompilerComparison(evidence.directory);
    expect(result.status).toBe("equivalent");
    expect(result.comparisons[0]?.referenceStable).toBe(false);
    expect(result.comparisons[0]?.referenceOutcomeMatches).toBeNull();
  });

  it("rejects unstable diagnostic repeats while preserving locations and global diagnostics", () => {
    const evidence = fixture({
      pinned: { exitCode: 1, stdout: diagnostic },
      candidate: { exitCode: 1, stdout: diagnostic },
    });
    const changed = "error TS18003: No inputs were found.\n";
    fs.writeFileSync(
      path.join(evidence.directory, "core-incremental-cold-candidate-2.stdout"),
      changed,
    );
    evidence.row(3).diagnosticSha256 = hash(changed);
    evidence.row(3).stdoutBytes = Buffer.byteLength(changed);
    evidence.save();
    expect(auditCompilerComparison(evidence.directory).comparisons[0]?.stable).toBe(false);
  });

  it("returns a failing CLI status for collected but divergent evidence", () => {
    const evidence = fixture({
      pinned: { exitCode: 0, stdout: "" },
      candidate: { exitCode: 1, stdout: diagnostic },
    });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../scripts/audit-compiler-comparison.mts", import.meta.url)),
        evidence.directory,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe("divergent");
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[compiler-comparison] FAILED (exit 1)");
  });
});
