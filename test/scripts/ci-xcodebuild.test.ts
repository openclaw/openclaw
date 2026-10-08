import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/ci-xcodebuild.py");

describe.skipIf(process.platform === "win32")("CI Xcode diagnostics", () => {
  it.each([
    { buildExit: 0, diagnosticExit: 0 },
    { buildExit: 65, diagnosticExit: 1 },
  ])("preserves build exit $buildExit with diagnostic exit $diagnosticExit", (fixture) => {
    const root = tempDirs.make("openclaw-ci-xcodebuild-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const trace = path.join(root, "build.json");
    const args = [
      "-project",
      "project with spaces/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-destination",
      "platform=iOS Simulator,id=fixture",
      "build-for-testing",
    ];
    for (const command of ["sysctl", "xcrun", "xcodebuild"]) {
      const executable = path.join(bin, command);
      writeFileSync(
        executable,
        `#!/usr/bin/env python3
import json, os, sys
if ${JSON.stringify(command)} == "xcodebuild":
    with open(os.environ["FIXTURE_TRACE"], "w") as trace:
        json.dump({"args": sys.argv[1:], "cwd": os.getcwd()}, trace)
    print("BUILD_OUTPUT", flush=True)
    print("BUILD_STDERR", file=sys.stderr, flush=True)
    raise SystemExit(${fixture.buildExit})
print(${JSON.stringify(command)} + " " + " ".join(sys.argv[1:]), flush=True)
raise SystemExit(${fixture.diagnosticExit})
`,
      );
      chmodSync(executable, 0o755);
    }

    const result = spawnSync("python3", [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FIXTURE_TRACE: trace,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(fixture.buildExit);
    expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual({ args, cwd: root });
    expect(result.stderr).toContain("BUILD_STDERR");
    expect(result.stdout).toContain("sysctl hw.ncpu hw.memsize hw.model");
    expect(result.stdout).toContain("xcrun simctl list devices booted");
    const events = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("[ios-build]"))
      .map((line) => {
        expect(line).toMatch(/^\[ios-build\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00 /u);
        return line.replace(/^\[ios-build\] \S+ /u, "");
      });
    expect(events).toEqual([
      "runner hardware start",
      expect.stringMatching(
        new RegExp(`^runner hardware end elapsed=.* exit=${fixture.diagnosticExit}$`, "u"),
      ),
      "booted simulators start",
      expect.stringMatching(
        new RegExp(`^booted simulators end elapsed=.* exit=${fixture.diagnosticExit}$`, "u"),
      ),
      "xcodebuild start",
      expect.stringMatching(
        new RegExp(`^xcodebuild end elapsed=.* exit=${fixture.buildExit}$`, "u"),
      ),
    ]);
    expect(result.stdout.indexOf("xcodebuild start")).toBeLessThan(
      result.stdout.indexOf("BUILD_OUTPUT"),
    );
    expect(result.stdout.indexOf("BUILD_OUTPUT")).toBeLessThan(
      result.stdout.indexOf("xcodebuild end"),
    );
  });
});
