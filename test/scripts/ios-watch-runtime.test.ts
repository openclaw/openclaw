import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  ["ready", 0],
  ["missing", 0],
  ["boot-failed", 0],
  ["boot-stopped", 0],
  ["unrecoverable", 145],
  ["download-failed", 70],
  ["import-failed", 70],
  ["cleanup-failed", 74],
] as const)(
  "provisions a bootable Watch runtime and cleans up its probe: %s",
  (scenario, expectedStatus) => {
    const root = tempDirs.make("openclaw-watch-runtime-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const calls = path.join(root, "calls");
    const tool = String.raw`#!/bin/bash
set -euo pipefail
printf "%s %s\n" "$(basename "$0")" "$*" >> "$FIXTURE_CALLS"
if [[ "$(basename "$0")" == "xcrun" ]]; then
  case "$1 $2" in
    "simctl create")
      if [[ "$FIXTURE_SCENARIO" == "missing" && ! -f "$FIXTURE_ROOT/imported" ]]; then
        echo "runtime path not found" >&2
        exit 145
      fi
      # Creating metadata need not boot (or even mount) the runtime.
      mkdir "$FIXTURE_ROOT/device"
      echo "00000000-0000-0000-0000-000000000001"
      ;;
    "simctl bootstatus")
      if [[ "$FIXTURE_SCENARIO" == "unrecoverable" || ( "$FIXTURE_SCENARIO" != "ready" && "$FIXTURE_SCENARIO" != "cleanup-failed" && ! -f "$FIXTURE_ROOT/imported" ) ]]; then
        if [[ "$FIXTURE_SCENARIO" == "boot-stopped" ]]; then exit 0; fi
        echo "runtime path not found" >&2
        exit 145
      fi
      touch "$FIXTURE_ROOT/device/booted"
      ;;
    "simctl getenv")
      [[ -f "$FIXTURE_ROOT/device/booted" ]] || exit 149
      echo "/fixture/home"
      ;;
    "simctl shutdown")
      [[ -f "$FIXTURE_ROOT/device/booted" ]] || exit 149
      rm "$FIXTURE_ROOT/device/booted"
      ;;
    "simctl delete")
      [[ "$3" == "00000000-0000-0000-0000-000000000001" ]]
      if [[ "$FIXTURE_SCENARIO" == "cleanup-failed" ]]; then exit 74; fi
      rmdir "$FIXTURE_ROOT/device"
      ;;
    *) exit 3 ;;
  esac
elif [[ "$1" == "-downloadPlatform" ]]; then
  # A cached download is not evidence that CoreSimulator can boot a device.
  if [[ "$#" == 4 ]]; then echo "watchOS 27.0 is already downloaded."; exit 70; fi
  if [[ "$FIXTURE_SCENARIO" == "download-failed" ]]; then exit 70; fi
  [[ "$5" == "-exportPath" ]]
  touch "$6/watchOS 27.0.simruntime.dmg"
elif [[ "$1" == "-importPlatform" ]]; then
  [[ -f "$2" ]]
  if [[ "$FIXTURE_SCENARIO" == "import-failed" ]]; then exit 70; fi
  touch "$FIXTURE_ROOT/imported"
else
  exit 3
fi
`;
    for (const name of ["xcrun", "xcodebuild"]) {
      const file = path.join(bin, name);
      writeFileSync(file, tool);
      chmodSync(file, 0o755);
    }
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const step = workflow.jobs["ios-screenshot-capture"].steps.find(
      (entry: { name?: string }) => entry.name === "Install Watch screenshot runtime",
    );
    const result = spawnSync("/bin/bash", ["-e", "-c", step.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        FIXTURE_ROOT: root,
        FIXTURE_CALLS: calls,
        FIXTURE_SCENARIO: scenario,
      },
    });
    expect(result.status, result.stderr).toBe(expectedStatus);
    const observed = readFileSync(calls, "utf8");
    if (scenario === "ready" || scenario === "cleanup-failed") {
      expect(observed).not.toContain("xcodebuild");
    } else if (scenario === "download-failed") {
      expect(observed).not.toContain("xcodebuild -importPlatform");
    } else {
      expect(observed).toContain("xcodebuild -importPlatform");
    }
    expect(existsSync(path.join(root, "device")), "all deletable probes must be removed").toBe(
      scenario === "cleanup-failed",
    );
    expect(readdirSync(root).filter((name) => name.startsWith("openclaw-watch-runtime."))).toEqual(
      [],
    );
  },
);
