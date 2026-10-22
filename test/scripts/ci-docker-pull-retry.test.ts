import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = path.resolve("scripts/ci-docker-pull-retry.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempBin({ binary = "timeout", killAfter = true, exit = 0 } = {}) {
  const dir = tempDirs.make("openclaw-ci-docker-pull-");
  const timeoutArgs = path.join(dir, "timeout-args.txt");
  const dockerArgs = path.join(dir, "docker-args.txt");
  if (binary) {
    writeExecutable(
      path.join(dir, binary),
      `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "--kill-after=1s" ]; then exit ${killAfter ? 0 : 1}; fi
printf "%s\\n" "$*" >${JSON.stringify(timeoutArgs)}
while [ "$#" -gt 0 ] && [ "$1" != "docker" ]; do shift; done
exec "$@"`,
    );
  }
  writeExecutable(
    path.join(dir, "docker"),
    `#!/bin/sh
set -eu
printf "%s\\n" "$*" >>${JSON.stringify(dockerArgs)}
exit ${exit}`,
  );
  return { dir, timeoutArgs, dockerArgs };
}

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function runPullHelper(binDir: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", [SCRIPT_PATH, "registry.example/openclaw:test"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DOCKER_PULL_ATTEMPTS: "1",
      OPENCLAW_DOCKER_PULL_RETRY_DELAY_SECONDS: "0",
      OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS: "42",
      ...env,
      PATH: binDir,
    },
  });
}

describe("scripts/ci-docker-pull-retry.sh", () => {
  it.each([
    { name: "GNU timeout", binary: "timeout", killAfter: true },
    { name: "plain timeout", binary: "timeout", killAfter: false },
    { name: "GNU gtimeout", binary: "gtimeout", killAfter: true },
  ])("bounds Docker pulls with $name", ({ binary, killAfter }) => {
    const { dir, timeoutArgs, dockerArgs } = makeTempBin({ binary, killAfter });
    const result = runPullHelper(dir);

    expect(result.status).toBe(0);
    expect(readFileSync(timeoutArgs, "utf8").trim()).toBe(
      `${killAfter ? "--kill-after=30s " : ""}42s docker pull registry.example/openclaw:test`,
    );
    expect(readFileSync(dockerArgs, "utf8").trim()).toBe("pull registry.example/openclaw:test");
  });

  it("fails fast when timeout and gtimeout are unavailable", () => {
    const { dir, dockerArgs } = makeTempBin({ binary: "" });
    const result = runPullHelper(dir);

    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "timeout or gtimeout command not found; cannot bound Docker pull after 42s",
    );
    expect(existsSync(dockerArgs)).toBe(false);
  });

  it("returns the last pull failure status after retries are exhausted", () => {
    const { dir, dockerArgs } = makeTempBin({ exit: 42 });
    const result = runPullHelper(dir, { OPENCLAW_DOCKER_PULL_ATTEMPTS: "2" });

    expect(result.status).toBe(42);
    expect(result.stderr).toContain("Docker pull failed or timed out after 42s: status=42");
    expect(readFileSync(dockerArgs, "utf8")).toBe(
      "pull registry.example/openclaw:test\npull registry.example/openclaw:test\n",
    );
  });
});
