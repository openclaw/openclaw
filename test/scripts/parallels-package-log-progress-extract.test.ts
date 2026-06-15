// Parallels Package Log Progress Extract tests cover parallels package log progress extract script behavior.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/parallels-package/log-progress-extract.mjs";
const tempRoots = useAutoCleanupTempDirTracker();

function makeTempRoot(): string {
  return tempRoots.make("openclaw-parallels-progress-");
}

function runExtract(logPath?: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...(logPath ? [logPath] : [])], {
    encoding: "utf8",
  });
}

describe("parallels package log progress extractor", () => {
  it("prints a blank status when the log is absent", () => {
    const result = runExtract(path.join(makeTempRoot(), "missing.log"));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\n");
  });

  it("extracts the latest progress line from recent log output", () => {
    const logPath = path.join(makeTempRoot(), "phase.log");
    writeFileSync(logPath, "==> Build package\nwarn: transient\n==> Copy artifact\n");

    const result = runExtract(logPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Copy artifact\n");
  });

  it("does not let stale progress hide recent warnings in long logs", () => {
    const logPath = path.join(makeTempRoot(), "phase.log");
    writeFileSync(
      logPath,
      `==> Stale build step\n${"ordinary output\n".repeat(24 * 1024)}warn: recent package issue\n`,
    );

    const result = runExtract(logPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("warn: recent package issue\n");
  });
});
