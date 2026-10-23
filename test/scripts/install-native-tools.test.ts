import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const read = (file: string) => readFileSync(file, "utf8");

const installers = [
  ["xcodegen", "yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip"],
  ["swift-tools", "nicklockwood/SwiftFormat/releases/download/0.63.1/swiftformat.zip"],
  ["periphery", "peripheryapp/periphery/releases/download/3.8.0/periphery-3.8.0.zip"],
].map(([name, release]) => ({
  script: `scripts/install-${name}.sh`,
  url: `https://github.com/${release}`,
}));

const writeExecutable = (filePath: string, lines: string[]): void =>
  writeFileSync(filePath, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines, ""].join("\n"), {
    mode: 0o755,
  });

function exec(command: string, args: string[], cwd = process.cwd(), env = process.env, code = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(code);
  return result;
}

function makeFixture(version?: string) {
  const root = tempDirs.make("openclaw-native-tool-installer-");
  const file = (name: string) => path.join(root, name);
  const binDir = file("bin");
  const bundleDir = file("bundle");
  const installDir = file("install directory");
  const archive = file("periphery.zip");
  const stub = (name: string, lines: string[]) => writeExecutable(path.join(binDir, name), lines);
  const env = {
    ...process.env,
    TMPDIR: root,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  mkdirSync(binDir);
  if (version !== undefined) {
    mkdirSync(bundleDir);
    writeExecutable(path.join(bundleDir, "periphery"), [
      'printf "%s\\n" "$0" "$@" >>"$TMPDIR/periphery-calls.txt"',
      '[[ "$#" -eq 1 && "$1" == "version" ]]',
      '[[ -f "$(dirname "$0")/libIndexStore.dylib" ]]',
      `printf "%s\\n" "${version}"`,
    ]);
    writeFileSync(path.join(bundleDir, "libIndexStore.dylib"), "fixture index store\n");
    writeFileSync(path.join(bundleDir, "LICENSE.md"), "fixture license\n");
    exec("zip", ["-q", archive, "periphery", "libIndexStore.dylib", "LICENSE.md"], bundleDir);
    stub("curl", [
      'while [[ "$#" -gt 0 ]]; do',
      '  case "$1" in',
      '    --output|-o) cp "$TMPDIR/periphery.zip" "$2"; exit 0 ;;',
      "  esac",
      "  shift",
      "done",
      "exit 64",
    ]);
  }
  return {
    file,
    stub,
    installed: (name: string) => path.join(installDir, name),
    run: (script: string, exitCode: number) =>
      exec("bash", [script, installDir], process.cwd(), env, exitCode),
  };
}

describe.runIf(process.platform !== "win32")("native tool installers", () => {
  it.each(
    [28, 56].flatMap((exitCode) =>
      installers.map(({ script, url }) => ({ script, url, exitCode })),
    ),
  )("bounds downloads in $script (exit $exitCode)", ({ script, url, exitCode }) => {
    const { file, stub, run } = makeFixture();
    stub("curl", ['printf "%s\\n" "$@" >"$TMPDIR/curl-args.txt"', `exit ${exitCode}`]);

    run(script, exitCode);
    const args = read(file("curl-args.txt")).trimEnd().split("\n");
    const options = Object.fromEntries(args.map((arg, i) => [arg, args[i + 1]]).toReversed());
    expect(options).toMatchObject({
      "--connect-timeout": "10",
      "--max-time": "120",
      "--retry": "3",
      "--retry-max-time": "120",
    });
    expect(args).toEqual(expect.arrayContaining(["--retry-all-errors", url]));
  });

  it.each(installers)("rejects wrong digests in $script", ({ script }) => {
    const { file, stub, run, installed } = makeFixture("3.8.0");
    const unzipCalls = file("bin/unzip-calls.txt");
    stub("unzip", ['printf "%s\\n" "$@" >"$(dirname "$0")/unzip-calls.txt"', "exit 99"]);

    const result = run(script, 1);
    expect(result.stderr).toContain("checksum mismatch");
    const untouched = [unzipCalls, file("periphery-calls.txt"), installed("periphery")];
    expect(untouched.map(existsSync)).toEqual([false, false, false]);
  });

  it.each([
    ["3.8.0", 0],
    ["3.8.1", 1],
  ] as const)("installs the complete bundle and verifies version %s", (version, exitCode) => {
    const { file, stub, run, installed } = makeFixture(version);
    // Substitute only the digest boundary; extraction, installation, and execution stay real.
    stub("shasum", [
      '[[ "$#" -eq 3 && "$1" == "-a" && "$2" == "256" ]]',
      'cmp "$3" "$TMPDIR/periphery.zip"',
      'printf "%s  %s\\n" "07d4e286e31dd79164df39097e0b59f533c94badbe18158464a455ea88a166d7" "$3"',
    ]);

    run("scripts/install-periphery.sh", exitCode);
    expect(["libIndexStore.dylib", "LICENSE.md"].map((name) => read(installed(name)))).toEqual([
      "fixture index store\n",
      "fixture license\n",
    ]);
    expect(read(file("periphery-calls.txt"))).toBe(`${installed("periphery")}\nversion\n`);
  });
});
