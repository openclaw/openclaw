import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { auditCompilerComparison } from "../../scripts/audit-compiler-comparison.mts";
import {
  assertCompilerNetworkIsolation,
  captureCompilerComparisonOutput,
  readCompilerComparisonMetrics,
} from "../../scripts/lib/compiler-comparison-io.mts";
import { networkFixture } from "./compiler-comparison-network.fixtures.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const diagnostic =
  "src/commands/backup-record.ts(39,48): error TS2345: Argument of type 'string' is not assignable to parameter of type '\"failed\" | \"ok\"'.\n";

describe("compiler network isolation", () => {
  it.each([false, true])("accepts observed inactive fallback devices: %s", (fallbacks) => {
    expect(assertCompilerNetworkIsolation(networkFixture(fallbacks))).toEqual({
      policy: "linux-none-with-inactive-fallbacks-v1",
      inactiveFallbackDevices: fallbacks ? 4 : 0,
    });
  });

  it.each([
    ["gre0", "778", "0x80"],
    ["gretap0", "1", "0x1002"],
    ["erspan0", "1", "0x1002"],
    ["ip_vti0", "768", "0x80"],
    ["ip6_vti0", "769", "0x80"],
  ])("covers the documented inactive sibling %s", (name, type, flags) => {
    const evidence = networkFixture();
    evidence.probe += `sysfs\t${name}\t${type}\t${flags}\tdown\nproc\t${name}\n`;
    expect(assertCompilerNetworkIsolation(evidence).inactiveFallbackDevices).toBe(1);
  });

  it("accepts mixed fallback names whose locale and code-unit ordering differ", () => {
    const evidence = networkFixture(true);
    evidence.probe += "sysfs\tip_vti0\t768\t0x80\tdown\nproc\tip_vti0\n";
    expect(assertCompilerNetworkIsolation(evidence).inactiveFallbackDevices).toBe(5);
  });

  it.each([
    ["unknown down device", "tunl0", "unrecognized-device"],
    ["wrong tunnel type", "sysfs\ttunl0\t768", "sysfs\ttunl0\t1"],
    ["administratively up tunnel", "sysfs\ttunl0\t768\t0x80", "sysfs\ttunl0\t768\t0x81"],
    [
      "unknown operational state",
      "sysfs\ttunl0\t768\t0x80\tdown",
      "sysfs\ttunl0\t768\t0x80\tunknown",
    ],
    ["invalid flags", "sysfs\ttunl0\t768\t0x80", "sysfs\ttunl0\t768\tn/a"],
    ["missing loopback", "sysfs\tlo\t772\t0x9\tunknown\n", ""],
    ["inactive loopback", "sysfs\tlo\t772\t0x9", "sysfs\tlo\t772\t0x8"],
    ["inventory mismatch", "proc\ttunl0\n", ""],
    ["duplicate device", "proc\tlo\n", "proc\tlo\nproc\tlo\n"],
    ["missing IPv4 read completion", "routes4\tcomplete\n", ""],
    ["unreadable IPv6 routes", "routes6\tcomplete", "routes6\tunreadable"],
    ["nonloopback IPv4 route", "routes4\tcomplete", "route4\ttunl0\nroutes4\tcomplete"],
    ["nonloopback IPv6 route", "route6\tlo", "route6\tip6tnl0"],
    ["shared network namespace", "namespace\tnet:[2]", "namespace\tnet:[1]"],
    ["missing network namespace", "namespace\tnet:[2]\n", ""],
    ["missing capability", "capability\tCapPrm\t0000000000000000\n", ""],
    ["privilege escalation", "no-new-privs\t1", "no-new-privs\t0"],
    ["successful TCP connection", "tcp\tENETUNREACH", "tcp\tconnected"],
    ["refused TCP connection", "tcp\tENETUNREACH", "tcp\tECONNREFUSED"],
    ["TCP timeout", "tcp\tENETUNREACH", "tcp\ttimeout"],
    ["missing TCP proof", "tcp\tENETUNREACH\n", ""],
  ])("rejects %s", (_name, before, after) => {
    const evidence = networkFixture(true);
    evidence.probe = evidence.probe.replaceAll(before, after);
    expect(() => assertCompilerNetworkIsolation(evidence)).toThrow();
  });

  it.each(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])("rejects retained %s", (name) => {
    const evidence = networkFixture();
    evidence.probe = evidence.probe.replace(
      "capability\t" + name + "\t0000000000000000",
      "capability\t" + name + "\t0000000000001000",
    );
    expect(() => assertCompilerNetworkIsolation(evidence)).toThrow("retained capabilities");
  });
});

describe("compiler-controlled metrics", () => {
  it("bounds combined output before writing artifacts and preserves split UTF-8", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-output-"));
    temporary.push(directory);
    const file = path.join(directory, "stdout");
    const fd = fs.openSync(file, "w");
    try {
      const output = captureCompilerComparisonOutput({ stdout: fd, stderr: fd });
      output.accept(Buffer.from("ok"), "stdout");
      expect(() => output.accept(Buffer.alloc(64 * 1024 * 1024), "stderr")).toThrow("64 MiB");
      expect(fs.readFileSync(file, "utf8")).toBe("ok");
      expect(output.finish()).toEqual({ stdout: "", stderr: "" });
    } finally {
      fs.closeSync(fd);
    }
    const output = captureCompilerComparisonOutput();
    const bytes = Buffer.from("界");
    output.accept(bytes.subarray(0, 1), "stdout");
    output.accept(bytes.subarray(1), "stdout");
    expect(output.finish().stdout).toBe("界");
  });
  it("reads numeric GNU time output and rejects oversized or malformed content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-metrics-"));
    temporary.push(directory);
    const file = path.join(directory, "result");
    fs.writeFileSync(file, "Command exited with non-zero status 1\n1.25 1 0.25 1024 1\n");
    expect(readCompilerComparisonMetrics(file)).toEqual([1.25, 1, 0.25, 1024, 1]);
    fs.writeFileSync(file, "0".repeat(4097));
    expect(() => readCompilerComparisonMetrics(file)).toThrow("exceeds 4096");
    fs.writeFileSync(file, "1 NaN 0 1024 0\n");
    expect(() => readCompilerComparisonMetrics(file)).toThrow("Invalid compiler metrics");
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compiler-metrics-"));
    temporary.push(directory);
    const fifo = path.join(directory, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const module = new URL("../../scripts/lib/compiler-comparison-io.mts", import.meta.url);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readCompilerComparisonMetrics } from ${JSON.stringify(module.href)};
       try { readCompilerComparisonMetrics(${JSON.stringify(fifo)}); process.exitCode = 1; }
       catch (error) { if (!error.message.includes("regular file")) throw error; }`,
      ],
      { encoding: "utf8", timeout: 2000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    fs.symlinkSync(fifo, path.join(directory, "link"));
    expect(() => readCompilerComparisonMetrics(path.join(directory, "link"))).toThrow();
  });
});

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
  write("network-isolation.json", networkFixture());
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
  it("rejects absent or invalid isolation evidence even with passing compiler outcomes", () => {
    const evidence = fixture();
    const network = networkFixture();
    network.probe = network.probe.replace("no-new-privs\t1", "no-new-privs\t0");
    evidence.write("network-isolation.json", network);
    expect(() => auditCompilerComparison(evidence.directory)).toThrow("Privilege escalation");
    fs.unlinkSync(path.join(evidence.directory, "network-isolation.json"));
    expect(() => auditCompilerComparison(evidence.directory)).toThrow("ENOENT");
  });
  it.each([
    { cpus: 4, memoryGiB: 24, swapBytes: 0, error: null },
    { cpus: 8, memoryGiB: 24, swapBytes: 0, error: "four CPUs" },
    { cpus: 4, memoryGiB: 12, swapBytes: 0, error: "24 GiB" },
    { cpus: 4, memoryGiB: 24, swapBytes: 1, error: "forbids swap" },
  ])("keeps the capacity control distinct and checks its declared limits: %j", (profile) => {
    const evidence = fixture();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(evidence.directory, "metadata.json"), "utf8"),
    );
    evidence.write("metadata.json", {
      ...metadata,
      capacityControl: true,
      cpus: profile.cpus,
      limits: { memoryBytes: profile.memoryGiB * 1024 ** 3, swapBytes: profile.swapBytes },
    });
    if (profile.error) {
      expect(() => auditCompilerComparison(evidence.directory)).toThrow(profile.error);
    } else {
      const result = auditCompilerComparison(evidence.directory);
      expect(result.scope.capacityControl).toBe(true);
      expect(result.qualificationPassed).toBe(true);
    }
  });

  it("rejects a diagnostic memory profile even when all compiler outcomes pass", () => {
    const evidence = fixture();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(evidence.directory, "metadata.json"), "utf8"),
    );
    evidence.write("metadata.json", { ...metadata, memoryDiagnostic: "10GiB" });
    expect(() => auditCompilerComparison(evidence.directory)).toThrow(
      "Memory diagnostics are not qualification evidence",
    );
  });

  it("does not lose a declared profile or reference when its entire batch is missing", () => {
    const evidence = fixture();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(evidence.directory, "metadata.json"), "utf8"),
    );
    const expectedSamples = evidence.rows.map((row) =>
      [row.graph, row.mode, row.compiler, row.iteration].join("-"),
    );
    expectedSamples.push("core-single-threaded-reference-1");
    evidence.write("metadata.json", { ...metadata, expectedSamples });
    fs.mkdirSync(path.join(evidence.directory, "metrics"));
    evidence.write("metrics/core-single-threaded-reference-1.json", {
      wallSeconds: 1,
      userSeconds: 1,
      sysSeconds: 0,
      peakRssKiB: 1024,
      exitCode: 0,
      processExitCode: 137,
    });
    const proofs = { ...evidence.proofs, reference: evidence.proofs.pinned };
    evidence.write("input-parity.json", [{ graph: "core", proofs }]);
    for (const label of ["config", "files"]) {
      fs.copyFileSync(
        path.join(evidence.directory, `core-pinned-${label}.txt`),
        path.join(evidence.directory, `core-reference-${label}.txt`),
      );
    }
    const result = auditCompilerComparison(evidence.directory);
    expect(result.status).toBe("incomplete");
    expect(result.missing).toContain("Planned sample missing: core-single-threaded-reference-1");
    expect(result.typecheckPassed).toBe(false);
  });

  it("requires equal reference inputs for a planned collection", () => {
    const evidence = fixture();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(evidence.directory, "metadata.json"), "utf8"),
    );
    evidence.write("metadata.json", {
      ...metadata,
      expectedSamples: evidence.rows.map((row) =>
        [row.graph, row.mode, row.compiler, row.iteration].join("-"),
      ),
    });
    const different = "/libs/lib.es2022.d.ts\n/work/missing.ts\n";
    evidence.write("input-parity.json", [
      {
        graph: "core",
        proofs: {
          ...evidence.proofs,
          reference: { config: evidence.proofs.pinned.config, files: { sha256: hash(different) } },
        },
      },
    ]);
    fs.copyFileSync(
      path.join(evidence.directory, "core-pinned-config.txt"),
      path.join(evidence.directory, "core-reference-config.txt"),
    );
    fs.writeFileSync(path.join(evidence.directory, "core-reference-files.txt"), different);
    expect(auditCompilerComparison(evidence.directory).comparisons[0]?.inputEqual).toBe(false);
  });

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
