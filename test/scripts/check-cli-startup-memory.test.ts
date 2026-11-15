import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing } from "../../scripts/check-cli-startup-memory.mjs";
import { withEnv } from "../../src/test-utils/env.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const aliasError = "--json and --summary must refer to different files";
const probeCount = testing.cases.length * testing.sampleCount;
const runCheck = testing.runStartupMemoryCheck;
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const successSpawn = (rssMb = 1) => ({
  signal: null,
  status: 0,
  stderr: `__OPENCLAW_MAX_RSS_KB__=${rssMb * 1024}\n`,
  stdout: "",
});

function reportFixture() {
  const tempRoot = tempRoots.make("openclaw-startup-memory-");
  return {
    tempRoot,
    jsonPath: path.join(tempRoot, "startup-memory.json"),
    summaryPath: path.join(tempRoot, "summary.md"),
  };
}

function reportArgs(tempRoot: string) {
  return [
    "--json",
    path.join(tempRoot, "startup-memory.json"),
    "--summary",
    path.join(tempRoot, "summary.md"),
  ];
}

function expectAdmissionFailure(run: ReturnType<typeof captureReportRun>, failure: object) {
  expect(run.failure).toMatchObject(failure);
  expect(run.probes).toBe(0);
}

beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function runStartupMemoryCheckWithHelpSamples(
  helpSamplesMb: number[],
  tempRoot = tempRoots.make("openclaw-startup-memory-test-"),
) {
  let sampleIndex = 0;
  const homes = new Set<string>();
  const result = runCheck(reportArgs(tempRoot), {
    platform: "linux",
    spawnSync: (_command: string, args: string[], options: { env: Record<string, string> }) => {
      expect(args[0]).toMatch(/bench-entry\.mjs$/u);
      expect(args[1]).not.toBe("openclaw.mjs");
      const home = options.env.HOME;
      if (!home) {
        throw new Error("benchmark HOME was not set");
      }
      expect(homes.has(home)).toBe(false);
      homes.add(home);
      const caseIndex = Math.floor(sampleIndex / testing.sampleCount);
      const caseSampleIndex = sampleIndex % testing.sampleCount;
      sampleIndex += 1;
      const rssMb = caseIndex === 0 ? (helpSamplesMb[caseSampleIndex] ?? 1) : 1;
      return successSpawn(rssMb);
    },
  });
  expect(homes.size).toBe(probeCount);
  expect(result!.skipped).toBe(false);
  return result;
}

function captureReportRun(
  tempRoot: string,
  jsonPath: string,
  summaryPath: string,
  onSpawn?: (probe: number) => ReturnType<typeof successSpawn>,
  suppliedHome?: string,
) {
  const homeRoot = suppliedHome ?? path.join(tempRoot, "homes");
  if (!suppliedHome) {
    mkdirSync(homeRoot);
  }
  let failure: unknown;
  let probes = 0;
  withEnv({ TMPDIR: homeRoot, TEMP: homeRoot, TMP: homeRoot }, () => {
    try {
      runCheck(["--json", jsonPath, "--summary", summaryPath], {
        platform: process.platform,
        spawnSync: () => {
          probes += 1;
          return onSpawn?.(probes) ?? successSpawn();
        },
      });
    } catch (error) {
      failure = error;
    }
  });
  return { failure, homeRoot, probes };
}

function detectFilesystemAlias(
  tempRoot: string,
  firstSuffix: readonly string[],
  secondSuffix: readonly string[],
): boolean {
  const sentinelRoot = path.join(tempRoot, "sentinel");
  const firstPath = path.join(sentinelRoot, ...firstSuffix);
  mkdirSync(path.dirname(firstPath), { recursive: true });
  writeFileSync(firstPath, "sentinel\n", { flag: "wx" });
  const first = lstatSync(firstPath, { bigint: true });
  const second = lstatSync(path.join(sentinelRoot, ...secondSuffix), {
    bigint: true,
    throwIfNoEntry: false,
  });
  rmSync(sentinelRoot, { recursive: true });
  return second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

describe("check-cli-startup-memory", () => {
  it("keeps the Linux help startup budget tight while allowing macOS RSS overhead", () => {
    expect(testing.resolveDefaultLimitsMb("linux").help).toBe(100);
    expect(testing.resolveDefaultLimitsMb("darwin").help).toBeGreaterThan(100);
  });

  it.each([
    { label: "bounded tolerance", offsets: [20, 0.5, -20], maxOffset: 0.5, status: "pass" },
    {
      label: "Actions overage warning",
      offsets: [1.5, 1.25, -20],
      maxOffset: 1.25,
      status: "fail",
    },
  ])("reports the median cold-start RSS with $label", ({ offsets, maxOffset, status }) => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const { tempRoot, jsonPath, summaryPath } = reportFixture();
    const helpLimitMb = testing.resolveDefaultLimitsMb(process.platform).help;
    const helpSamplesMb = offsets.map((offset) => helpLimitMb + offset);
    const diagnostic =
      status === "fail" ? vi.spyOn(console, "error").mockImplementation(() => {}) : undefined;
    const actionsSummary = path.join(tempRoot, "github-summary.md");
    if (status === "fail") {
      vi.stubEnv("CI", "1");
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("GITHUB_STEP_SUMMARY", actionsSummary);
    }
    const result = runStartupMemoryCheckWithHelpSamples(helpSamplesMb, tempRoot);
    const expected = {
      limitMb: helpLimitMb,
      rssToleranceMb: 1,
      effectiveLimitMb: helpLimitMb + 1,
      maxRssMb: helpLimitMb + maxOffset,
      rssSamplesMb: helpSamplesMb,
      status,
    };
    expect(result!.results[0]).toMatchObject(expected);
    const report = readJson(jsonPath);
    expect(report.results[0]).toMatchObject(expected);
    const summary = readFileSync(status === "fail" ? actionsSummary : summaryPath, "utf8");
    if (status === "fail") {
      expect(diagnostic?.mock.calls.flat().join("\n")).toContain("::warning file=");
      expect(summary).toContain("CLI startup memory budget");
    } else {
      expect(summary).toContain(
        `base limit ${helpLimitMb.toFixed(1)} MB; RSS tolerance 1.0 MB; effective ceiling ${(helpLimitMb + 1).toFixed(1)} MB; samples: ${helpSamplesMb.map((sample) => `${sample.toFixed(1)} MB`).join(", ")}`,
      );
    }
  });

  it("keeps invalid startup memory env values from bypassing budgets", () => {
    const name = "OPENCLAW_STARTUP_MEMORY_HELP_MB";
    const read = (value: string) => testing.readPositiveNumberEnv(name, 100, { [name]: value });
    for (const value of ["abc", "1e3", "0x10", "0"]) {
      expect(() => read(value)).toThrow(`${name} must be a positive number`);
    }
    expect(read("125.5")).toBe(125.5);
  });

  it("keeps invalid startup memory timeout env values from parsing loosely", () => {
    const name = "OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS";
    const read = (value: string) => testing.readPositiveIntEnv(name, 60_000, { [name]: value });
    expect(() => read("1e3")).toThrow(`${name} must be a positive number`);
    for (const value of ["1000.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => read(value)).toThrow(`${name} must be a positive integer`);
    }
    expect(read("1000")).toBe(1000);
  });

  it("rejects missing startup memory artifact paths", () => {
    for (const flag of ["--json", "--summary"]) {
      for (const next of [[], ["-h"]]) {
        expect(() => testing.parseArgs([flag, ...next])).toThrow(
          /--(?:json|summary) requires a path/u,
        );
      }
    }
  });

  describe.runIf(process.platform === "darwin" || process.platform === "linux")(
    "report reservations",
    () => {
      it.each(["hardlink", "dangling-symlink"] as const)(
        "rejects %s aliases before benchmarks",
        (kind) => {
          const tempRoot = tempRoots.make("openclaw-startup-memory-alias-");
          const reportsDir = path.join(tempRoot, "reports");
          const targetPath = path.join(reportsDir, "report");
          const aliasPath = path.join(reportsDir, "alias");
          const sentinel = "existing report must survive\n";
          mkdirSync(reportsDir);
          let firstPath = targetPath;
          let secondPath = targetPath;
          if (kind === "hardlink") {
            writeFileSync(targetPath, sentinel);
            linkSync(targetPath, aliasPath);
            secondPath = aliasPath;
          } else {
            symlinkSync(path.basename(targetPath), aliasPath, "file");
            firstPath = aliasPath;
          }
          const run = captureReportRun(tempRoot, firstPath, secondPath);

          expect.soft(run).toMatchObject({ failure: { message: aliasError }, probes: 0 });
          expect.soft(readdirSync(run.homeRoot)).toEqual([]);
          if (kind === "dangling-symlink") {
            expect.soft(existsSync(targetPath)).toBe(false);
            expect.soft(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
          } else {
            expect.soft(readFileSync(targetPath, "utf8")).toBe(sentinel);
          }
        },
      );

      it("follows filesystem identity for nested mixed Unicode folds", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-name-");
        const reportsDir = path.join(tempRoot, "reports");
        mkdirSync(reportsDir);
        const jsonSuffix = ["Directory-\u00c9", "Report-\u03a3"];
        const summarySuffix = ["directory-e\u0301", "report-\u03c2"];
        const aliases = detectFilesystemAlias(tempRoot, jsonSuffix, summarySuffix);
        const jsonPath = path.join(reportsDir, ...jsonSuffix);
        const summaryPath = path.join(reportsDir, ...summarySuffix);
        const run = captureReportRun(tempRoot, jsonPath, summaryPath);

        expect.soft(readdirSync(run.homeRoot)).toEqual([]);
        if (aliases) {
          expect.soft(run).toMatchObject({ failure: { message: aliasError }, probes: 0 });
          expect.soft(readdirSync(reportsDir)).toEqual([]);
        } else {
          expect.soft(run).toMatchObject({
            failure: undefined,
            probes: probeCount,
          });
          expect.soft(readJson(jsonPath)).toMatchObject({
            status: "pass",
          });
          expect.soft(readFileSync(summaryPath, "utf8")).toContain("Status: pass");
        }
      });

      it("removes reserved leaves and empty parents when admission fails", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-cleanup-");
        const reportsRoot = path.join(tempRoot, "created");
        const reportPath = path.join(reportsRoot, "nested", "report");
        const run = captureReportRun(tempRoot, reportPath, reportPath);

        expectAdmissionFailure(run, { message: aliasError });
        expect(existsSync(reportPath)).toBe(false);
        expect(existsSync(reportsRoot)).toBe(false);
        expect(readdirSync(run.homeRoot)).toEqual([]);
      });

      it("rejects a symlink cycle before benchmarks", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-cycle-");
        const first = path.join(tempRoot, "first");
        const second = path.join(tempRoot, "second");
        const summaryPath = path.join(tempRoot, "summary.md");
        const sentinel = "summary survives\n";
        symlinkSync("second", first, "file");
        symlinkSync("first", second, "file");
        writeFileSync(summaryPath, sentinel);
        const run = captureReportRun(tempRoot, first, summaryPath);

        expectAdmissionFailure(run, { code: "ELOOP" });
        expect(readFileSync(summaryPath, "utf8")).toBe(sentinel);
        expect(readlinkSync(first)).toBe("second");
        expect(readlinkSync(second)).toBe("first");
      });

      it.each(["terminal", "traversal"] as const)(
        "rejects dangling %s targets before benchmarks",
        (kind) => {
          const { tempRoot, jsonPath, summaryPath } = reportFixture();
          const terminal = kind === "terminal";
          const protectedPath = path.join(tempRoot, terminal ? "blocked-home" : "victim");
          const target = `missing${path.sep}..${terminal ? "" : `${path.sep}victim`}`;
          const link = terminal ? summaryPath : jsonPath;
          const sentinel = terminal ? "unchanged\n" : "victim survives\n";
          writeFileSync(protectedPath, sentinel);
          symlinkSync(target, link, "file");
          const run = captureReportRun(
            tempRoot,
            jsonPath,
            summaryPath,
            undefined,
            terminal ? protectedPath : undefined,
          );
          expectAdmissionFailure(
            run,
            terminal ? { message: "--json and --summary must refer to files" } : { code: "ENOENT" },
          );
          expect(readFileSync(protectedPath, "utf8")).toBe(sentinel);
          expect(readlinkSync(link)).toBe(target);
          expect(existsSync(terminal ? jsonPath : summaryPath)).toBe(false);
          expect(existsSync(path.join(tempRoot, "missing"))).toBe(false);
        },
      );

      it("rejects a replaced summary path before truncating either held report", () => {
        const { tempRoot, jsonPath, summaryPath } = reportFixture();
        const displacedPath = path.join(tempRoot, "reserved-summary");
        const sentinel = "replacement survives\n";
        const run = captureReportRun(tempRoot, jsonPath, summaryPath, (probe) => {
          if (probe === 1) {
            renameSync(summaryPath, displacedPath);
            writeFileSync(summaryPath, sentinel);
          }
          return successSpawn();
        });

        expect(run.failure).toMatchObject({
          message: "--json or --summary changed during startup benchmarks",
        });
        expect(run.probes).toBe(probeCount);
        expect(readFileSync(summaryPath, "utf8")).toBe(sentinel);
        expect(readFileSync(displacedPath, "utf8")).toBe("");
        expect(existsSync(jsonPath)).toBe(false);
      });

      it.each([
        ["summary after the json write", "summary", 1],
        ["json during the summary write", "json", 2],
      ] as const)("rejects a replaced %s", (_label, replacedOutput, replacementWrite) => {
        const { tempRoot, jsonPath, summaryPath } = reportFixture();
        const replacedPath = replacedOutput === "json" ? jsonPath : summaryPath;
        const otherPath = replacedOutput === "json" ? summaryPath : jsonPath;
        const displacedPath = path.join(tempRoot, `reserved-${replacedOutput}`);
        const replacement = "replacement survives\n";
        const displacedSeed = "reserved report survives\n";
        const scriptUrl = pathToFileURL(
          path.resolve(__dirname, "..", "..", "scripts/check-cli-startup-memory.mjs"),
        ).href;
        const result = spawnSync(
          testNodeExecPath,
          [
            "--input-type=module",
            "--eval",
            `
              import fs from "node:fs";
              import { syncBuiltinESMExports } from "node:module";
              const originalWriteFileSync = fs.writeFileSync;
              let reportWrites = 0;
              fs.writeFileSync = function (file, ...args) {
                const result = originalWriteFileSync.call(this, file, ...args);
                if (typeof file === "number" && ++reportWrites === ${replacementWrite}) {
                  ${
                    replacedOutput === "summary"
                      ? `originalWriteFileSync(${JSON.stringify(replacedPath)}, ${JSON.stringify(displacedSeed)});`
                      : ""
                  }
                  fs.renameSync(${JSON.stringify(replacedPath)}, ${JSON.stringify(displacedPath)});
                  originalWriteFileSync(${JSON.stringify(replacedPath)}, ${JSON.stringify(replacement)});
                }
                return result;
              };
              syncBuiltinESMExports();
              const { testing } = await import(${JSON.stringify(scriptUrl)});
              let failure;
              console.log = () => {};
              try {
                testing.runStartupMemoryCheck(
                  ["--json", ${JSON.stringify(jsonPath)}, "--summary", ${JSON.stringify(summaryPath)}],
                  {
                    platform: process.platform,
                    spawnSync: () => (${JSON.stringify(successSpawn())}),
                  },
                );
              } catch (error) {
                failure = error;
              }
              process.stdout.write(JSON.stringify({
                failure: failure instanceof Error ? failure.message : null,
                reportWrites,
                otherExists: fs.existsSync(${JSON.stringify(otherPath)}),
                replacement: fs.readFileSync(${JSON.stringify(replacedPath)}, "utf8"),
                displaced: fs.readFileSync(${JSON.stringify(displacedPath)}, "utf8"),
              }));
            `,
          ],
          { encoding: "utf8" },
        );

        expect(result).toMatchObject({ status: 0, stderr: "" });
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({
          failure: "--json or --summary changed during startup benchmarks",
          reportWrites: replacementWrite,
          otherExists: false,
          replacement,
        });
        if (replacedOutput === "summary") {
          expect(output.displaced).toBe(displacedSeed);
        } else {
          expect(JSON.parse(output.displaced)).toMatchObject({ status: "pass" });
        }
      });

      it("publishes failure reports before surfacing a benchmark failure", () => {
        const { tempRoot, jsonPath, summaryPath } = reportFixture();
        const run = captureReportRun(tempRoot, jsonPath, summaryPath, () => ({
          ...successSpawn(),
          status: 1,
          stderr: "benchmark failed\n",
        }));

        expect(run).toMatchObject({
          failure: { message: expect.stringContaining("--help exited with 1") },
          probes: testing.cases.length,
        });
        expect(readJson(jsonPath)).toMatchObject({ status: "fail" });
        expect(readFileSync(summaryPath, "utf8")).toContain("Status: fail");
        expect(readFileSync(summaryPath, "utf8")).toContain("--help: --help exited with 1");
      });
    },
  );

  it("keeps probe timeouts blocking with Actions=true", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const seenOptions: Array<{ timeout?: number; killSignal?: string }> = [];
    const timeoutError = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" });
    vi.stubEnv("GITHUB_ACTIONS", "true");

    expect(() =>
      runCheck(reportArgs(tempRoot), {
        platform: "linux",
        timeoutMs: 1234,
        spawnSync: (
          _command: string,
          _args: string[],
          options: { killSignal?: string; timeout?: number },
        ) => {
          seenOptions.push({ timeout: options.timeout, killSignal: options.killSignal });
          return {
            error: timeoutError,
            signal: "SIGKILL",
            status: null,
            stderr: "",
            stdout: "",
          };
        },
      }),
    ).toThrow("--help timed out after 1234ms");
    expect(seenOptions).toEqual(
      testing.cases.map(() => ({ timeout: 1234, killSignal: "SIGKILL" })),
    );
  });

  it("rejects zero RSS markers instead of passing empty resource evidence", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    expect(() =>
      runCheck(reportArgs(tempRoot), {
        platform: "darwin",
        spawnSync: () => successSpawn(0),
      }),
    ).toThrow("--help did not report max RSS");
  });
});
