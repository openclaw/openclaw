import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
const functionStart = source.indexOf("assert_legacy_operator_update_noop() {");
const functionEnd = source.indexOf("\nassert_legacy_operator_doctor_clean()", functionStart);
const header = "  node --input-type=module - \"$ARTIFACT_ROOT/update-noop.json\" <<'NODE'\n";
const start = source.indexOf(header, functionStart);
const end = source.indexOf("\nNODE\n", start);
if (functionStart < 0 || start < functionStart || end < start || end >= functionEnd) {
  throw new Error("Expected the installed updater no-op assertion entry point");
}
const assertion = source.slice(start + header.length, end);
const advisory = {
  name: "managed-service-reconciliation",
  command: "openclaw gateway install --force",
  cwd: "/fixture/openclaw",
  durationMs: 0,
  exitCode: 0,
  advisory: {
    kind: "recoverable-maintenance",
    message:
      "service management skipped: non-default state dir or config path. " +
      "Rerun with HOME set to the OS account home, without OPENCLAW_HOME, and with " +
      "OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH either unset or pointing at the " +
      "canonical paths for that account home and profile to manage the gateway service during update.",
  },
};
const noop = {
  status: "skipped",
  reason: "already-current",
  root: "/fixture/openclaw",
  steps: [],
};

// Run the same Node payload used by the shell entry point, not a duplicate assertion.
// This qualifies the harness; the published-driver cell separately runs the real updater.
function check(report: Record<string, unknown>) {
  const file = path.join(tempDirs.make("survivor-update-noop-"), "update.json");
  writeFileSync(file, "Plugin fixture notice\n" + JSON.stringify(report));
  return spawnSync(process.execPath, ["--input-type=module", "-", file], {
    input: assertion,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("legacy-operator already-current update", () => {
  it.each([
    { name: "accepts no steps", report: noop, accepted: true },
    {
      name: "accepts the non-default service advisory",
      report: { ...noop, steps: [advisory] },
      accepted: true,
    },
    {
      name: "rejects a package mutation",
      report: { ...noop, steps: [{ name: "global install swap", exitCode: 0, durationMs: 0 }] },
    },
    {
      name: "rejects unrelated maintenance",
      report: {
        ...noop,
        steps: [{ ...advisory, advisory: { ...advisory.advisory, message: "ownership conflict" } }],
      },
    },
    {
      name: "rejects an executed service operation",
      report: { ...noop, steps: [{ ...advisory, advisory: undefined }] },
    },
    {
      name: "rejects elapsed service work",
      report: { ...noop, steps: [{ ...advisory, durationMs: 1 }] },
    },
    {
      name: "rejects a failed service receipt",
      report: { ...noop, steps: [{ ...advisory, exitCode: 1 }] },
    },
    {
      name: "rejects a repair request",
      report: { ...noop, steps: [advisory], nextAction: "openclaw update repair" },
    },
    { name: "rejects an executed update", report: { ...noop, status: "ok" } },
    { name: "rejects a different skip reason", report: { ...noop, reason: "no-update-root" } },
    { name: "rejects missing steps", report: { ...noop, steps: undefined } },
    { name: "rejects repeated maintenance", report: { ...noop, steps: [advisory, advisory] } },
  ])("$name", ({ report, accepted }) => {
    const result = check(report);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
  });
});
