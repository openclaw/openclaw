import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runBash(
  script: string,
  tempDir?: string,
  args: string[] = [],
  killSignal: NodeJS.Signals = "SIGTERM",
) {
  return spawnSync("bash", ["-c", script, "bash", ...args], {
    encoding: "utf8",
    ...(tempDir && {
      timeout: 5_000,
      killSignal,
      env: { ...process.env, TMPDIR: tempDir, OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64" },
    }),
  });
}

describe("Docker E2E observability", () => {
  it("prints the bounded heartbeat log before signal cleanup", () => {
    const tempDir = tempDirs.make("openclaw-heartbeat-signal-log-");
    const result = runBash(
      `
set -euo pipefail
source scripts/lib/docker-e2e-logs.sh
run_logged_print_heartbeat signal-proof 30 bash -c 'printf "old log head%0256drecent failure tail\\n" 0; kill -TERM "$PPID"'
`,
      tempDir,
    );
    expect(result.status, result.stderr).toBe(143);
    expect(result.stdout).not.toContain("old log head");
    expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
    expect(result.stdout).toContain("showing last 64");
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it.each([
    [0, "", true],
    [1, "", true],
    [143, "TERM", false],
    [143, "TERM", true],
    [130, "INT", false],
    [129, "HUP", false],
  ] as const)(
    "preserves redirected Codex run diagnostics on exit %i (%s, long=%s)",
    (status, signal, long) => {
      const tempDir = tempDirs.make("openclaw-codex-run-cleanup-");
      const script = readFileSync("scripts/e2e/codex-npm-plugin-live-docker.sh", "utf8");
      const cleanupSetup = script.slice(
        script.indexOf('run_log=""'),
        script.indexOf("trap cleanup EXIT") + "trap cleanup EXIT".length,
      );
      const result = runBash(
        `
set -Eeuo pipefail
# Bound the pre-fix self-copy if EXIT cleanup still writes into its input log.
ulimit -f 8
source scripts/lib/docker-e2e-package.sh
proof_status="$1"
proof_signal="$2"
proof_long="$3"
docker_e2e_docker_cmd() {
  printf '%s\\n' "$*" >>"$TMPDIR/docker-cleanup"
}
docker_e2e_docker_run_cmd() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --cidfile ]; then
      printf 'proof-container\\n' >"$2"
      break
    fi
    shift
  done
  cat >"$TMPDIR/container-stdin"
  if [ "$proof_long" = true ]; then
    printf 'old log head%0256d' 0
  fi
  printf 'recent failure tail\\n'
  if [ -n "$proof_signal" ]; then
    kill -"$proof_signal" "$$"
  else
    return "$proof_status"
  fi
}
${cleanupSetup}
run_log="$TMPDIR/run.log"
# Use the actual harness: its signal trap exits inside this function redirection.
if ! docker_e2e_run_with_harness image-name bash -s >"$run_log" 2>&1 <<'SH'; then
container stdin proof
SH
  exit 1
fi
`,
        tempDir,
        [String(status), signal, String(long)],
        "SIGKILL",
      );
      expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal })).toBe(
        status,
      );
      expect(readFileSync(path.join(tempDir, "container-stdin"), "utf8")).toBe(
        "container stdin proof\n",
      );
      const dockerCommands = readFileSync(path.join(tempDir, "docker-cleanup"), "utf8");
      expect(dockerCommands.trimEnd().split("\n").at(-1)).toBe("rm -f proof-container");
      expect(readdirSync(tempDir).toSorted()).toEqual(["container-stdin", "docker-cleanup"]);
      expect(result.stdout).not.toContain("old log head");
      if (status === 0) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
        expect(result.stdout.includes("showing last 64")).toBe(long);
      }
    },
  );
});
