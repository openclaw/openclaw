import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempBin(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function resolveDockerRunArgs(pathPrefix: string) {
  const script = [
    "source scripts/lib/live-docker-auth.sh",
    "ARGS=()",
    "openclaw_live_init_docker_run_args ARGS 42s",
    "printf '%s\\n' \"${ARGS[@]}\"",
  ].join("\n");

  return execFileSync("/bin/bash", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: pathPrefix,
    },
  }).trimEnd().split("\n");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("scripts/lib/live-docker-auth.sh", () => {
  it("adds a kill-after grace period when timeout supports it", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-gnu-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
        "  exit 0",
        "fi",
        "exit 64",
        "",
      ].join("\n"),
    );

    expect(resolveDockerRunArgs(binDir)).toEqual([
      "timeout",
      "--kill-after=30s",
      "42s",
      "docker",
      "run",
    ]);
  });

  it("falls back to plain timeout when kill-after is unavailable", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-plain-");
    writeExecutable(
      path.join(binDir, "timeout"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--kill-after=1s" ]; then',
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    expect(resolveDockerRunArgs(binDir)).toEqual(["timeout", "42s", "docker", "run"]);
  });

  it("uses docker directly when timeout is unavailable", () => {
    const binDir = makeTempBin("openclaw-live-docker-auth-no-timeout-");

    expect(resolveDockerRunArgs(binDir)).toEqual(["docker", "run"]);
  });
});
