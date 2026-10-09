import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { budget: undefined, expectedStatus: 0 },
  { budget: "135", expectedStatus: 0 },
  { budget: "90", expectedStatus: 1 },
])("bounds survivor readiness by its startup budget ($budget)", ({ budget, expectedStatus }) => {
  const root = tempDirs.make("survivor-start-budget-");
  const runner = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const startGateway = runner.slice(
    runner.indexOf("start_gateway() {"),
    runner.indexOf("\nensure_gateway_started() {"),
  );
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
${startGateway}
SCENARIO=base
ticks=0
# Model process liveness and the clock without booting a Gateway or sleeping.
node() { printf '0'; }
env() { :; }
kill() { return 0; }
sleep() {
  ticks=$((ticks + 1))
  if [ "$ticks" -eq 480 ]; then printf '[gateway] ready\\n' >>"$GATEWAY_LOG"; fi
}
openclaw_e2e_probe_http() { [ "$1" = http://127.0.0.1:18789/readyz ]; }
start_gateway
wait "$gateway_pid"
`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GATEWAY_LOG: path.join(root, "gateway.log"),
        ...(budget === undefined ? {} : { OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS: budget }),
      },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
  if (expectedStatus === 1) {
    expect(result.stdout).toContain("Gateway did not become ready");
  }
});
