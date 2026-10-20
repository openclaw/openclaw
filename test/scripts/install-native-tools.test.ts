import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const installers = [
  ["xcodegen", "yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip"],
  ["swift-tools", "nicklockwood/SwiftFormat/releases/download/0.63.1/swiftformat.zip"],
  ["periphery", "peripheryapp/periphery/releases/download/3.8.0/periphery-3.8.0.zip"],
].map(([name, release]) => ({
  script: `scripts/install-${name}.sh`,
  url: `https://github.com/${release}`,
}));

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines, ""].join("\n"), {
    mode: 0o755,
  });
}

function makeFixture(version?: string) {
  const root = tempDirs.make("openclaw-native-tool-installer-");
  const file = (name: string) => path.join(root, name);
  const binDir = file("bin");
  const bundleDir = file("bundle");
  const installDir = file("install directory");
  const archive = file("periphery.zip");
  const callsPath = file("periphery-calls.txt");
  const stub = (name: string, lines: string[]) => writeExecutable(path.join(binDir, name), lines);
  mkdirSync(binDir);
  if (version !== undefined) {
    mkdirSync(bundleDir);
    writeExecutable(path.join(bundleDir, "periphery"), [
      'printf "%s\\n" "$0" "$@" >>"$OPENCLAW_TEST_PERIPHERY_CALLS"',
      '[[ "$#" -eq 1 && "$1" == "version" ]]',
      '[[ -f "$(dirname "$0")/libIndexStore.dylib" ]]',
      'printf "%s\\n" "$OPENCLAW_TEST_PERIPHERY_VERSION"',
    ]);
    writeFileSync(path.join(bundleDir, "libIndexStore.dylib"), "fixture index store\n");
    writeFileSync(path.join(bundleDir, "LICENSE.md"), "fixture license\n");
    const zip = spawnSync(
      "zip",
      ["-q", archive, "periphery", "libIndexStore.dylib", "LICENSE.md"],
      {
        cwd: bundleDir,
        encoding: "utf8",
      },
    );
    expect(zip.status, zip.stderr).toBe(0);
    stub("curl", [
      'while [[ "$#" -gt 0 ]]; do',
      '  case "$1" in',
      '    --output|-o) cp "$OPENCLAW_TEST_PERIPHERY_ARCHIVE" "$2"; exit 0 ;;',
      "  esac",
      "  shift",
      "done",
      "exit 64",
    ]);
  }
  return {
    file,
    stub,
    callsPath,
    installed: (name: string) => path.join(installDir, name),
    run(script: string, exitCode: number) {
      const result = spawnSync("bash", [script, installDir], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: root,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          OPENCLAW_TEST_PERIPHERY_VERSION: version,
          OPENCLAW_TEST_PERIPHERY_ARCHIVE: archive,
          OPENCLAW_TEST_PERIPHERY_CALLS: callsPath,
          OPENCLAW_TEST_CURL_ARGS_PATH: file("curl-args.txt"),
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      return result;
    },
  };
}

describe.runIf(process.platform !== "win32")("native tool installers", () => {
  it.each(
    installers.flatMap(({ script, url }) =>
      [28, 56].map((exitCode) => ({ script, url, exitCode })),
    ),
  )("bounds downloads in $script (exit $exitCode)", ({ script, url, exitCode }) => {
    const fixture = makeFixture();
    fixture.stub("curl", [
      'printf "%s\\n" "$@" >"$OPENCLAW_TEST_CURL_ARGS_PATH"',
      `exit ${exitCode}`,
    ]);

    fixture.run(script, exitCode);
    const args = readFileSync(fixture.file("curl-args.txt"), "utf8").trimEnd().split("\n");
    expect(
      Object.fromEntries(args.map((arg, index) => [arg, args[index + 1]]).toReversed()),
    ).toMatchObject({
      "--connect-timeout": "10",
      "--max-time": "120",
      "--retry": "3",
      "--retry-max-time": "120",
    });
    expect(args).toContain("--retry-all-errors");
    expect(args).toContain(url);
  });

  it.each(installers)("rejects wrong digests in $script", ({ script }) => {
    const fixture = makeFixture("3.8.0");
    const unzipCalls = fixture.file("bin/unzip-calls.txt");
    fixture.stub("unzip", ['printf "%s\\n" "$@" >"$(dirname "$0")/unzip-calls.txt"', "exit 99"]);

    // This ZIP is extractable, but its real SHA-256 is not the pinned release digest.
    const result = fixture.run(script, 1);
    expect(result.stderr).toContain("checksum mismatch");
    expect([unzipCalls, fixture.callsPath, fixture.installed("periphery")].map(existsSync)).toEqual(
      [false, false, false],
    );
  });

  it.each([
    ["3.8.0", 0],
    ["3.8.1", 1],
  ] as const)("installs the complete bundle and verifies version %s", (version, exitCode) => {
    const fixture = makeFixture(version);
    // Substitute only the digest boundary; extraction, installation, and execution stay real.
    fixture.stub("shasum", [
      '[[ "$#" -eq 3 && "$1" == "-a" && "$2" == "256" ]]',
      'cmp "$3" "$OPENCLAW_TEST_PERIPHERY_ARCHIVE"',
      'printf "%s  %s\\n" "07d4e286e31dd79164df39097e0b59f533c94badbe18158464a455ea88a166d7" "$3"',
    ]);

    fixture.run("scripts/install-periphery.sh", exitCode);
    expect(
      ["libIndexStore.dylib", "LICENSE.md"].map((name) =>
        readFileSync(fixture.installed(name), "utf8"),
      ),
    ).toEqual(["fixture index store\n", "fixture license\n"]);
    expect(readFileSync(fixture.callsPath, "utf8")).toBe(
      `${fixture.installed("periphery")}\nversion\n`,
    );
  });
});
