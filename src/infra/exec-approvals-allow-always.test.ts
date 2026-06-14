// Tests persistent always-allow pattern helpers that remain below the planner boundary.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAllowAlwaysPatternEntries } from "./exec-approvals-allowlist.js";
import {
  makeExecutable,
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
  makeTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  analyzeArgvCommand,
  evaluateExecAllowlist,
  resolveAllowAlwaysPatterns,
} from "./exec-approvals.js";
import { matchAllowlist } from "./exec-command-resolution.js";

describe("resolveAllowAlwaysPatterns", () => {
  it("returns direct executable trust paths", () => {
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: "rg -n needle",
          argv: ["rg", "-n", "needle"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "rg",
              resolvedPath: "/opt/homebrew/bin/rg",
              resolvedRealPath: "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg",
              executableName: "rg",
            }),
          }),
        },
      ],
    });

    expect(patterns).toEqual(["/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg"]);
  });

  it("does not persist interpreter-like executables by default", () => {
    const awk = path.join("/tmp", "awk");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${awk} '{print $1}' data.csv`,
          argv: [awk, "{print $1}", "data.csv"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: awk,
              resolvedPath: awk,
              executableName: "awk",
            }),
          }),
        },
      ],
    });

    expect(patterns).toStrictEqual([]);
  });

  it("persists benign interpreter-like executables when strict inline-eval is enabled", () => {
    const awk = path.join("/tmp", "awk");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${awk} -F, -f script.awk data.csv`,
          argv: [awk, "-F,", "-f", "script.awk", "data.csv"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: awk,
              resolvedPath: awk,
              executableName: "awk",
            }),
          }),
        },
      ],
      strictInlineEval: true,
    });

    expect(patterns).toEqual([awk]);
  });

  it("keeps inline interpreter programs out of strict inline-eval persistence", () => {
    const awk = path.join("/tmp", "awk");
    const patterns = resolveAllowAlwaysPatterns({
      segments: [
        {
          raw: `${awk} 'BEGIN{system("id")}'`,
          argv: [awk, 'BEGIN{system("id")}'],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: awk,
              resolvedPath: awk,
              executableName: "awk",
            }),
          }),
        },
      ],
      strictInlineEval: true,
    });

    expect(patterns).toStrictEqual([]);
  });

  it("persists POSIX shell script paths for non-inline wrapper invocations", () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const bash = makeExecutable(dir, "bash");
    const scriptsDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const script = path.join(scriptsDir, "save_crystal.sh");
    fs.writeFileSync(script, "echo ok\n");

    const analysis = analyzeArgvCommand({
      argv: [bash, "scripts/save_crystal.sh"],
      cwd: dir,
      env: makePathEnv(dir),
    });

    const patterns = resolveAllowAlwaysPatterns({
      segments: analysis.segments,
      cwd: dir,
      env: makePathEnv(dir),
      platform: process.platform,
    });

    expect(patterns).toEqual([script]);
  });

  it.each(["--rcfile", "--init-file", "--startup-file"])(
    "does not persist POSIX shell script paths when %s is present",
    (flag) => {
      if (process.platform === "win32") {
        return;
      }

      const dir = makeTempDir();
      const bash = makeExecutable(dir, "bash");
      const scriptsDir = path.join(dir, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, "evilrc"), "echo blocked\n");
      fs.writeFileSync(path.join(scriptsDir, "save_crystal.sh"), "echo ok\n");

      const analysis = analyzeArgvCommand({
        argv: [bash, flag, "scripts/evilrc", "scripts/save_crystal.sh"],
        cwd: dir,
        env: makePathEnv(dir),
      });

      const patterns = resolveAllowAlwaysPatterns({
        segments: analysis.segments,
        cwd: dir,
        env: makePathEnv(dir),
        platform: process.platform,
      });

      expect(patterns).toStrictEqual([]);
    },
  );

  it("keeps Windows strict inline-eval interpreter approvals argv-bound", () => {
    const awk = "C:\\temp\\awk.exe";
    const resolution = makeMockCommandResolution({
      execution: makeMockExecutableResolution({
        rawExecutable: awk,
        resolvedPath: awk,
        executableName: "awk",
      }),
    });

    const entries = resolveAllowAlwaysPatternEntries({
      segments: [
        {
          raw: `${awk} -F , -f script.awk data.csv`,
          argv: [awk, "-F", ",", "-f", "script.awk", "data.csv"],
          resolution,
        },
      ],
      platform: "win32",
      strictInlineEval: true,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pattern).toBe(awk);
    expect(typeof entries[0]?.argPattern).toBe("string");
    expect(
      matchAllowlist(
        entries,
        resolution.execution ?? null,
        [awk, "-F", ",", "-f", "script.awk", "data.csv"],
        "win32",
      )?.pattern,
    ).toBe(awk);
    expect(
      matchAllowlist(
        entries,
        resolution.execution ?? null,
        [awk, "-f", "other.awk", "secrets.csv"],
        "win32",
      ),
    ).toBeNull();
  });

  it("matches persisted PowerShell file script entries with argv patterns", () => {
    const dir = makeTempDir();
    makeExecutable(dir, "pwsh");
    const scriptPath = path.join(dir, "script.ps1");
    fs.writeFileSync(scriptPath, "");
    fs.chmodSync(scriptPath, 0o755);
    const env = makePathEnv(dir);

    const analysis = analyzeArgvCommand({
      argv: ["pwsh", "-File", scriptPath, ""],
      cwd: dir,
      env,
    });
    expect(analysis.ok).toBe(true);

    const entries = resolveAllowAlwaysPatternEntries({
      segments: analysis.segments,
      cwd: dir,
      env,
      platform: "win32",
    });

    expect(entries).toEqual([{ pattern: scriptPath, argPattern: "^\x00$" }]);
    expect(
      evaluateExecAllowlist({
        analysis,
        allowlist: entries,
        safeBins: new Set(),
        cwd: dir,
        env,
        platform: "win32",
      }).allowlistSatisfied,
    ).toBe(true);
  });
});
