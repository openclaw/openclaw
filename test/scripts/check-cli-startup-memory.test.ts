// Check Cli Startup Memory tests cover check cli startup memory script behavior.
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
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/check-cli-startup-memory.mjs";
import { withEnv } from "../../src/test-utils/env.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const aliasError = "--json and --summary must refer to different files";
const successSpawn = () => ({
  signal: null,
  status: 0,
  stderr: "__OPENCLAW_MAX_RSS_KB__=1024\n",
  stdout: "",
});

function expectNoNodeStack(stderr: string): void {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

function runStartupMemoryCheckWithHelpSamples(
  helpSamplesMb: number[],
  tempRoot = tempRoots.make("openclaw-startup-memory-test-"),
) {
  let sampleIndex = 0;
  return testing.runStartupMemoryCheck(
    [
      "--json",
      path.join(tempRoot, "startup-memory.json"),
      "--summary",
      path.join(tempRoot, "summary.md"),
    ],
    {
      platform: "linux",
      spawnSync: () => {
        const caseIndex = Math.floor(sampleIndex / testing.sampleCount);
        const caseSampleIndex = sampleIndex % testing.sampleCount;
        sampleIndex += 1;
        const rssMb = caseIndex === 0 ? (helpSamplesMb[caseSampleIndex] ?? 1) : 1;
        return {
          signal: null,
          status: 0,
          stderr: `__OPENCLAW_MAX_RSS_KB__=${rssMb * 1024}\n`,
          stdout: "",
        };
      },
    },
  );
}

function captureReportRun(
  tempRoot: string,
  jsonPath: string,
  summaryPath: string,
  onSpawn?: (probe: number) => ReturnType<typeof successSpawn>,
) {
  const homeRoot = path.join(tempRoot, "homes");
  mkdirSync(homeRoot);
  let failure: unknown;
  let probes = 0;
  withEnv({ TMPDIR: homeRoot, TEMP: homeRoot, TMP: homeRoot }, () => {
    try {
      testing.runStartupMemoryCheck(["--json", jsonPath, "--summary", summaryPath], {
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
  it("resolves the repository root from the script location", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts/check-cli-startup-memory.mjs"));
    const result = spawnSync(
      testNodeExecPath,
      [
        "--input-type=module",
        "--eval",
        `const mod = await import(${JSON.stringify(scriptUrl.href)}); console.log(mod.testing.repoRoot);`,
      ],
      {
        cwd: path.join(repoRoot, "test/scripts"),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(repoRoot);
  });

  it("keeps the Linux help startup budget tight while allowing macOS RSS overhead", () => {
    expect(testing.resolveDefaultLimitsMb("linux").help).toBe(100);
    expect(testing.resolveDefaultLimitsMb("darwin").help).toBeGreaterThan(100);
  });

  it("guards packaged plugin listing startup memory", () => {
    expect(testing.resolveDefaultLimitsMb("linux").pluginsList).toBe(400);
    expect(testing.resolveDefaultLimitsMb("darwin").pluginsList).toBeGreaterThan(350);
    expect(testing.cases).toContainEqual(
      expect.objectContaining({
        id: "pluginsList",
        args: ["openclaw.mjs", "plugins", "list", "--json"],
      }),
    );
  });

  it("keeps status startup headroom above Linux runner RSS variance", () => {
    expect(testing.resolveDefaultLimitsMb("linux").statusJson).toBe(450);
  });

  it("applies bounded runner RSS tolerance to the median of three cold-start samples", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const helpLimitMb = testing.resolveDefaultLimitsMb(process.platform).help;
    const helpSamplesMb = [helpLimitMb + 20, helpLimitMb + 0.5, helpLimitMb - 20];
    const result = runStartupMemoryCheckWithHelpSamples(helpSamplesMb, tempRoot);

    expect(result!.results[0]).toMatchObject({
      limitMb: helpLimitMb,
      rssToleranceMb: 1,
      effectiveLimitMb: helpLimitMb + 1,
      maxRssMb: helpLimitMb + 0.5,
      rssSamplesMb: helpSamplesMb,
      status: "pass",
    });
    const report = JSON.parse(readFileSync(path.join(tempRoot, "startup-memory.json"), "utf8"));
    expect(report.results[0]).toMatchObject({
      limitMb: helpLimitMb,
      rssToleranceMb: 1,
      effectiveLimitMb: helpLimitMb + 1,
      rssSamplesMb: helpSamplesMb,
    });
    expect(readFileSync(path.join(tempRoot, "summary.md"), "utf8")).toContain(
      `base limit ${helpLimitMb.toFixed(1)} MB; RSS tolerance 1.0 MB; effective ceiling ${(helpLimitMb + 1).toFixed(1)} MB; samples: ${helpSamplesMb.map((sample) => `${sample.toFixed(1)} MB`).join(", ")}`,
    );
  });

  it("still fails when most cold-start RSS samples exceed the bounded tolerance", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const helpLimitMb = testing.resolveDefaultLimitsMb(process.platform).help;
    const helpSamplesMb = [helpLimitMb + 1.5, helpLimitMb + 1.25, helpLimitMb - 20];

    expect(() => runStartupMemoryCheckWithHelpSamples(helpSamplesMb)).toThrow(
      `--help median max RSS ${(helpLimitMb + 1.25).toFixed(1)} MB exceeded effective ceiling ${helpLimitMb + 1} MB (base limit ${helpLimitMb} MB; RSS tolerance 1 MB; samples: ${helpSamplesMb.map((sample) => sample.toFixed(1)).join(", ")} MB)`,
    );
  });

  it("keeps invalid startup memory env values from bypassing budgets", () => {
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "abc",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "1e3",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "0x10",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "0",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "125.5",
      }),
    ).toBe(125.5);
  });

  it("keeps invalid startup memory timeout env values from parsing loosely", () => {
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive number");
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1000.5",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive integer");
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive integer");
    expect(
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1000",
      }),
    ).toBe(1000);
  });

  it("rejects missing startup memory artifact paths", () => {
    for (const args of [
      ["--json"],
      ["--json", "--summary"],
      ["--json", "-h"],
      ["--summary"],
      ["--summary", "--json"],
      ["--summary", "-h"],
    ]) {
      expect(() => testing.parseArgs(args)).toThrow(/--(?:json|summary) requires a path/u);
    }
  });

  describe.runIf(process.platform === "darwin" || process.platform === "linux")(
    "report reservations",
    () => {
      type AliasCase = readonly [
        kind: "exact" | "hardlink" | "symlink" | "dangling-symlink",
        reversed: boolean,
      ];
      it.each(
        (["exact", "hardlink", "symlink", "dangling-symlink"] as const).flatMap<AliasCase>(
          (kind) =>
            kind === "exact" ? [[kind, false]] : [false, true].map((reversed) => [kind, reversed]),
        ),
      )("rejects %s aliases before benchmarks (reversed: %s)", (kind, reversed) => {
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
        } else if (kind === "symlink") {
          writeFileSync(targetPath, sentinel);
          symlinkSync(path.basename(targetPath), aliasPath, "file");
          secondPath = aliasPath;
        } else if (kind === "dangling-symlink") {
          symlinkSync(path.basename(targetPath), aliasPath, "file");
          firstPath = aliasPath;
        } else {
          writeFileSync(targetPath, sentinel);
        }
        const [jsonPath, summaryPath] = reversed
          ? [secondPath, firstPath]
          : [firstPath, secondPath];
        const run = captureReportRun(tempRoot, jsonPath, summaryPath);

        expect.soft(run.failure).toMatchObject({ message: aliasError });
        expect.soft(run.probes).toBe(0);
        expect.soft(readdirSync(run.homeRoot)).toEqual([]);
        if (kind === "dangling-symlink") {
          expect.soft(existsSync(targetPath)).toBe(false);
        } else {
          expect.soft(readFileSync(targetPath, "utf8")).toBe(sentinel);
        }
        if (kind === "symlink" || kind === "dangling-symlink") {
          expect.soft(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
        }
      });

      const nameCases = [
        ["ASCII case", ["report"], ["REPORT"]],
        ["NFC/NFD", ["report-\u00e9"], ["report-e\u0301"]],
        ["sigma/final sigma", ["report-\u03c3"], ["report-\u03c2"]],
        ["sharp s expansion", ["report-\u00df"], ["report-ss"]],
        ["ff ligature expansion", ["report-\ufb00"], ["report-ff"]],
        ["long s", ["report-\u017f"], ["report-s"]],
        [
          "nested mixed folds",
          ["Directory-\u00c9", "Report-\u03a3"],
          ["directory-e\u0301", "report-\u03c2"],
        ],
        ["dotless I control", ["report-\u0131"], ["report-I"]],
        ["fullwidth A control", ["report-\uff21"], ["report-A"]],
        ["circled a control", ["report-\u24d0"], ["report-a"]],
        ["Roman I control", ["report-\u2160"], ["report-I"]],
        ["o-stroke control", ["report-\u00f8"], ["report-o"]],
        ["ae ligature control", ["report-\u00e6"], ["report-ae"]],
      ] as const;

      it.each(
        nameCases.flatMap(([label, first, second]) =>
          [false, true].map((reversed) => [label, reversed, first, second] as const),
        ),
      )(
        "follows actual filesystem name identity for %s (reversed: %s)",
        (label, reversed, first, second) => {
          const tempRoot = tempRoots.make("openclaw-startup-memory-name-");
          const reportsDir = path.join(tempRoot, "reports");
          mkdirSync(reportsDir);
          const [jsonSuffix, summarySuffix] = reversed ? [second, first] : [first, second];
          const aliases = detectFilesystemAlias(tempRoot, jsonSuffix, summarySuffix);
          const jsonPath = path.join(reportsDir, ...jsonSuffix);
          const summaryPath = path.join(reportsDir, ...summarySuffix);
          const run = captureReportRun(tempRoot, jsonPath, summaryPath);

          expect.soft(readdirSync(run.homeRoot), label).toEqual([]);
          if (aliases) {
            expect.soft(run.failure, label).toMatchObject({ message: aliasError });
            expect.soft(run.probes, label).toBe(0);
            expect.soft(readdirSync(reportsDir), label).toEqual([]);
          } else {
            expect.soft(run.failure, label).toBeUndefined();
            expect.soft(run.probes, label).toBe(testing.cases.length * testing.sampleCount);
            expect.soft(JSON.parse(readFileSync(jsonPath, "utf8")), label).toMatchObject({
              status: "pass",
            });
            expect.soft(readFileSync(summaryPath, "utf8"), label).toContain("Status: pass");
          }
        },
      );

      it("creates missing output parents and publishes both reports", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-parents-");
        const jsonPath = path.join(tempRoot, "json", "nested", "startup-memory.json");
        const summaryPath = path.join(tempRoot, "summary", "nested", "summary.md");
        const run = captureReportRun(tempRoot, jsonPath, summaryPath);

        expect(run.failure).toBeUndefined();
        expect(run.probes).toBe(testing.cases.length * testing.sampleCount);
        expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toMatchObject({ status: "pass" });
        expect(readFileSync(summaryPath, "utf8")).toContain("Status: pass");
      });

      it("removes reserved leaves and empty parents when admission fails", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-cleanup-");
        const reportsRoot = path.join(tempRoot, "created");
        const reportPath = path.join(reportsRoot, "nested", "report");
        const run = captureReportRun(tempRoot, reportPath, reportPath);

        expect(run.failure).toMatchObject({ message: aliasError });
        expect(run.probes).toBe(0);
        expect(existsSync(reportPath)).toBe(false);
        expect(existsSync(reportsRoot)).toBe(false);
        expect(readdirSync(run.homeRoot)).toEqual([]);
      });

      it("cleans unpublished reservations without masking an unexpected benchmark error", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-unpublished-");
        const reportsRoot = path.join(tempRoot, "created");
        const jsonPath = path.join(reportsRoot, "json", "report");
        const summaryPath = path.join(reportsRoot, "summary", "report");
        const primaryError = new Error("unexpected benchmark failure");
        const run = captureReportRun(tempRoot, jsonPath, summaryPath, () => {
          throw primaryError;
        });

        expect(run.failure).toBe(primaryError);
        expect(run.probes).toBe(1);
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

        expect(run.failure).toMatchObject({ code: "ELOOP" });
        expect(run.probes).toBe(0);
        expect(readFileSync(summaryPath, "utf8")).toBe(sentinel);
        expect(readlinkSync(first)).toBe("second");
        expect(readlinkSync(second)).toBe("first");
      });

      it.each(
        (
          [
            ["/", `missing${path.sep}`],
            ["/.", `missing${path.sep}.`],
            ["/..", `missing${path.sep}..`],
          ] as const
        ).flatMap(([terminal, target]) =>
          ["json", "summary"].map((output) => [terminal, output, target] as const),
        ),
      )("rejects dangling targets ending in %s for the %s output", (_terminal, output, target) => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-terminal-");
        const jsonPath = path.join(tempRoot, "startup-memory.json");
        const summaryPath = path.join(tempRoot, "summary.md");
        const linkPath = output === "json" ? jsonPath : summaryPath;
        const otherPath = output === "json" ? summaryPath : jsonPath;
        const blockedHome = path.join(tempRoot, "blocked-home");
        writeFileSync(blockedHome, "unchanged\n");
        symlinkSync(target, linkPath, "file");
        let probes = 0;

        withEnv({ TMPDIR: blockedHome, TEMP: blockedHome, TMP: blockedHome }, () => {
          expect(() =>
            testing.runStartupMemoryCheck(["--json", jsonPath, "--summary", summaryPath], {
              platform: process.platform,
              spawnSync: () => {
                probes += 1;
                return successSpawn();
              },
            }),
          ).toThrow("--json and --summary must refer to files");
        });

        expect(probes).toBe(0);
        expect(readlinkSync(linkPath)).toBe(target);
        expect(existsSync(otherPath)).toBe(false);
        expect(existsSync(path.join(tempRoot, "missing"))).toBe(false);
        expect(readFileSync(blockedHome, "utf8")).toBe("unchanged\n");
      });

      it("preserves raw traversal in dangling symlink targets", () => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-traversal-");
        const jsonPath = path.join(tempRoot, "startup-memory.json");
        const summaryPath = path.join(tempRoot, "summary.md");
        const victimPath = path.join(tempRoot, "victim");
        const target = `missing${path.sep}..${path.sep}victim`;
        const sentinel = "victim survives\n";
        symlinkSync(target, jsonPath, "file");
        writeFileSync(victimPath, sentinel);
        const run = captureReportRun(tempRoot, jsonPath, summaryPath);

        expect(run.failure).toMatchObject({ code: "ENOENT" });
        expect(run.probes).toBe(0);
        expect(readFileSync(victimPath, "utf8")).toBe(sentinel);
        expect(readlinkSync(jsonPath)).toBe(target);
        expect(existsSync(summaryPath)).toBe(false);
      });

      it.each(["json", "summary"] as const)(
        "rejects a replaced %s path before truncating either held report",
        (output) => {
          const tempRoot = tempRoots.make("openclaw-startup-memory-replacement-");
          const jsonPath = path.join(tempRoot, "startup-memory.json");
          const summaryPath = path.join(tempRoot, "summary.md");
          const changedPath = output === "json" ? jsonPath : summaryPath;
          const otherPath = output === "json" ? summaryPath : jsonPath;
          const displacedPath = path.join(tempRoot, `reserved-${output}`);
          const sentinel = "replacement survives\n";
          const run = captureReportRun(tempRoot, jsonPath, summaryPath, (probe) => {
            if (probe === 1) {
              renameSync(changedPath, displacedPath);
              writeFileSync(changedPath, sentinel);
            }
            return successSpawn();
          });

          expect(run.failure).toMatchObject({
            message: "--json or --summary changed during startup benchmarks",
          });
          expect(run.probes).toBe(testing.cases.length * testing.sampleCount);
          expect(readFileSync(changedPath, "utf8")).toBe(sentinel);
          expect(readFileSync(displacedPath, "utf8")).toBe("");
          expect(existsSync(otherPath)).toBe(false);
        },
      );

      it.each([
        ["summary after the json write", "summary", 1],
        ["json during the summary write", "json", 2],
      ] as const)("rejects a replaced %s", (_label, replacedOutput, replacementWrite) => {
        const tempRoot = tempRoots.make("openclaw-startup-memory-publication-race-");
        const jsonPath = path.join(tempRoot, "startup-memory.json");
        const summaryPath = path.join(tempRoot, "summary.md");
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
              const originalLog = console.log;
              console.log = () => {};
              try {
                testing.runStartupMemoryCheck(
                  ["--json", ${JSON.stringify(jsonPath)}, "--summary", ${JSON.stringify(summaryPath)}],
                  {
                    platform: process.platform,
                    spawnSync: () => ({
                      signal: null,
                      status: 0,
                      stderr: "__OPENCLAW_MAX_RSS_KB__=1024\\n",
                      stdout: "",
                    }),
                  },
                );
              } catch (error) {
                failure = error;
              } finally {
                console.log = originalLog;
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

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
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
        const tempRoot = tempRoots.make("openclaw-startup-memory-failure-");
        const jsonPath = path.join(tempRoot, "startup-memory.json");
        const summaryPath = path.join(tempRoot, "summary.md");
        const run = captureReportRun(tempRoot, jsonPath, summaryPath, () => ({
          signal: null,
          status: 1,
          stderr: "benchmark failed\n",
          stdout: "",
        }));

        expect(run.failure).toMatchObject({
          message: expect.stringContaining("--help exited with 1"),
        });
        expect(run.probes).toBe(testing.cases.length);
        expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toMatchObject({ status: "fail" });
        expect(readFileSync(summaryPath, "utf8")).toContain("Status: fail");
        expect(readFileSync(summaryPath, "utf8")).toContain("--help: --help exited with 1");
      });
    },
  );

  it("does not create a temp home before argument validation succeeds", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const result = spawnSync(testNodeExecPath, ["scripts/check-cli-startup-memory.mjs", "--json"], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    const result = spawnSync(testNodeExecPath, ["scripts/check-cli-startup-memory.mjs", "--wat"], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("times out startup probes instead of hanging indefinitely", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const seenTimeouts: Array<number | undefined> = [];
    const seenKillSignals: Array<string | undefined> = [];
    const timeoutError = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" });

    expect(() =>
      testing.runStartupMemoryCheck(
        [
          "--json",
          path.join(tempRoot, "startup-memory.json"),
          "--summary",
          path.join(tempRoot, "summary.md"),
        ],
        {
          platform: "linux",
          timeoutMs: 1234,
          spawnSync: (
            _command: string,
            _args: string[],
            options: { killSignal?: string; timeout?: number },
          ) => {
            seenTimeouts.push(options.timeout);
            seenKillSignals.push(options.killSignal);
            return {
              error: timeoutError,
              signal: "SIGKILL",
              status: null,
              stderr: "",
              stdout: "",
            };
          },
        },
      ),
    ).toThrow("--help timed out after 1234ms");
    expect(seenTimeouts).toEqual(testing.cases.map(() => 1234));
    expect(seenKillSignals).toEqual(testing.cases.map(() => "SIGKILL"));
  });

  it("rejects zero RSS markers instead of passing empty resource evidence", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    expect(() =>
      testing.runStartupMemoryCheck(
        [
          "--json",
          path.join(tempRoot, "startup-memory.json"),
          "--summary",
          path.join(tempRoot, "summary.md"),
        ],
        {
          platform: "darwin",
          spawnSync: () => ({
            signal: null,
            status: 0,
            stderr: "__OPENCLAW_MAX_RSS_KB__=0\n",
            stdout: "",
          }),
        },
      ),
    ).toThrow("--help did not report max RSS");
  });

  it("passes the generated RSS hook as a Node import URL", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const seenArgs: string[][] = [];
    const seenHomes: string[] = [];

    const result = testing.runStartupMemoryCheck(
      [
        "--json",
        path.join(tempRoot, "startup-memory.json"),
        "--summary",
        path.join(tempRoot, "summary.md"),
      ],
      {
        platform: "linux",
        spawnSync: (_command: string, args: string[], options: { env: Record<string, string> }) => {
          seenArgs.push(args);
          const home = options.env.HOME;
          if (!home) {
            throw new Error("benchmark HOME was not set");
          }
          seenHomes.push(home);
          return {
            error: null,
            signal: null,
            status: 0,
            stderr: "__OPENCLAW_MAX_RSS_KB__=1024\n",
            stdout: "",
          };
        },
      },
    );

    expect(result!.skipped).toBe(false);
    expect(seenArgs).toHaveLength(testing.cases.length * testing.sampleCount);
    expect(new Set(seenHomes).size).toBe(seenArgs.length);
    for (const args of seenArgs) {
      // The bench entry runs the launcher in-process instead of preloading an
      // --import hook, which would disable the dist ESM resolve fast path and
      // measure a non-default resolution configuration.
      expect(args[0]).toMatch(/bench-entry\.mjs$/u);
      expect(args[0]).not.toBe("--import");
      expect(args[1]).not.toBe("openclaw.mjs");
    }
  });
});
