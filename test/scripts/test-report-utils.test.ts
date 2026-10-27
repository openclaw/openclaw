import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectVitestAssertionDurations,
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
} from "../../scripts/test-report-utils.mts";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock.mockImplementation(actual.spawnSync),
  };
});

it("preserves external absolute paths as normalized absolute paths", () => {
  const externalFile = path.join(path.parse(process.cwd()).root, "tmp", "outside.test.ts");

  expect(normalizeTrackedRepoPath(externalFile)).toBe(externalFile.split(path.sep).join("/"));
});

const timedFile = {
  name: path.join(process.cwd(), "src", "alpha.test.ts"),
  startTime: 100,
  endTime: 460,
  assertionResults: [
    { duration: 25, fullName: "alpha fast", status: "passed" },
    { duration: 0, fullName: "alpha zero", status: "passed" },
  ],
};
it.each([
  [collectVitestFileDurations, { file: "src/alpha.test.ts", durationMs: 360, testCount: 2 }],
  [
    collectVitestAssertionDurations,
    { file: "src/alpha.test.ts", durationMs: 25, fullName: "alpha fast", status: "passed" },
  ],
] as const)("extracts durations with normalized paths (%s)", (collect, expected) => {
  const testResults = [
    timedFile,
    { name: "src/zero.test.ts", startTime: 300, endTime: 300, assertionResults: [{}] },
  ];
  expect(collect({ testResults }, normalizeTrackedRepoPath)).toEqual([expected]);
});

describe("scripts/test-report-utils runVitestJsonReport", () => {
  beforeEach(async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnSyncMock.mockReset().mockImplementation(actual.spawnSync);
  });

  it("reuses a supplied report without starting Vitest", async ({ onTestFinished }) => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-reuse-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const reportPath = path.join(root, "report.json");
    fs.writeFileSync(reportPath, JSON.stringify({ testResults: [] }));
    expect(runVitestJsonReport({ config: "missing.config.mjs", reportPath })).toBe(reportPath);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses distinct default report paths when invocations share a clock tick", async () => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mts");
    const reportPaths: string[] = [];
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe(process.execPath);
      expect(args.slice(0, -1)).toEqual([
        path.join(process.cwd(), "scripts/run-vitest.mjs"),
        "run",
        "--config",
        "test/vitest/vitest.unit.config.ts",
        "--reporter=json",
        "--outputFile",
      ]);
      const outputFileIndex = args.indexOf("--outputFile") + 1;
      const outputFile = expectDefined(args[outputFileIndex], "Vitest JSON report output path");
      reportPaths.push(outputFile);
      fs.writeFileSync(outputFile, `${JSON.stringify({ testResults: [] })}\n`, "utf8");
      return { status: 0 };
    });

    try {
      runVitestJsonReport({ config: "test/vitest/vitest.unit.config.ts" });
      runVitestJsonReport({ config: "test/vitest/vitest.unit.config.ts" });

      expect(reportPaths).toHaveLength(2);
      expect(reportPaths[0]).not.toBe(reportPaths[1]);
      for (const reportPath of reportPaths) {
        expect(path.dirname(reportPath)).toBe(os.tmpdir());
      }
    } finally {
      nowSpy.mockRestore();
      for (const reportPath of reportPaths) {
        fs.rmSync(reportPath, { force: true });
      }
    }
  });

  it("fails when Vitest exits successfully without writing a JSON report", async () => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mts");
    spawnSyncMock.mockReturnValue({ status: 0 });
    const reportPath = path.join(os.tmpdir(), `openclaw-vitest-json-missing-${Date.now()}.json`);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit ${String(code)}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        runVitestJsonReport({ config: "test/vitest/vitest.unit.config.ts", reportPath }),
      ).toThrow("process.exit 1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[test-report-utils] missing Vitest JSON report:"),
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(reportPath, { force: true });
    }
  });
});
