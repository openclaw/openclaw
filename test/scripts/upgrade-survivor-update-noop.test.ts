import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testBashExecPath = process.platform === "darwin" ? "/bin/bash" : "bash";
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
const doctorFunctionStart = functionEnd + 1;
const doctorFunctionEnd = source.indexOf(
  "\nprobe_legacy_operator_migration()",
  doctorFunctionStart,
);
if (doctorFunctionStart <= 0 || doctorFunctionEnd < doctorFunctionStart) {
  throw new Error("Expected the final legacy-operator Doctor assertion entry point");
}
const doctorAssertion = source.slice(doctorFunctionStart, doctorFunctionEnd);
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
const cleanup = {
  name: "recovery-artifact-cleanup",
  command: "openclaw update cleanup",
  cwd: "",
  durationMs: 12,
  exitCode: 0,
  diagnostics: [
    "Recovery cleanup removed 2 files (400 logical bytes); protected recovery artifacts were retained.",
  ],
};
const noop = {
  status: "skipped",
  reason: "already-current",
  root: "/fixture/openclaw",
  steps: [],
};
const legacyAuthWarning = {
  checkId: "core/doctor/browser",
  severity: "warning",
  message:
    "Legacy Browser Relay Authentication is enabled (browser.extensionRelay.allowLegacyAuth=true).",
};
const cleanDoctorReport = {
  schemaVersion: 1,
  ok: true,
  checksRun: 39,
  checksSkipped: 30,
  findings: [],
};
const legacyAuthDoctorReport = {
  ...cleanDoctorReport,
  ok: false,
  findings: [legacyAuthWarning],
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

// Execute the shell function itself so command settlement and set -e behavior stay under test.
function checkDoctor(
  report: Record<string, unknown>,
  doctorStatus: number,
  servedVersion = "2026.10.6",
) {
  const root = tempDirs.make("survivor-doctor-final-");
  const statusPath = path.join(root, "status.json");
  writeFileSync(statusPath, JSON.stringify({ gateway: { version: servedVersion } }));
  return spawnSync(
    testBashExecPath,
    [
      "-c",
      `set -Eeuo pipefail
ARTIFACT_ROOT="$1"
STATUS_JSON="$2"
candidate_version="$3"
COMMAND_TIMEOUT=1
openclaw_e2e_maybe_timeout() {
  printf '%s\\n' "$DOCTOR_REPORT" >"$ARTIFACT_ROOT/doctor-lint.json"
  : >"$ARTIFACT_ROOT/doctor-lint.err"
  return "$DOCTOR_STATUS"
}
${doctorAssertion}
assert_legacy_operator_doctor_clean
`,
      "legacy-operator-doctor-test",
      root,
      statusPath,
      "2026.10.6",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DOCTOR_REPORT: JSON.stringify(report),
        DOCTOR_STATUS: String(doctorStatus),
      },
      timeout: 10_000,
    },
  );
}

describe("legacy-operator already-current update", () => {
  it.each([
    { name: "accepts no steps", report: noop, accepted: true },
    {
      name: "accepts verified recovery cleanup",
      report: { ...noop, steps: [cleanup] },
      accepted: true,
    },
    {
      name: "accepts cleanup after service guidance",
      report: { ...noop, steps: [advisory, cleanup] },
      accepted: true,
    },
    { name: "rejects duplicate cleanup", report: { ...noop, steps: [cleanup, cleanup] } },
    { name: "rejects failed cleanup", report: { ...noop, steps: [{ ...cleanup, exitCode: 1 }] } },
    {
      name: "rejects unexplained cleanup",
      report: { ...noop, steps: [{ ...cleanup, diagnostics: [] }] },
    },
    {
      name: "rejects unrelated cleanup commands",
      report: { ...noop, steps: [{ ...cleanup, command: "openclaw gateway restart" }] },
    },
    {
      name: "accepts the non-default service advisory",
      report: { ...noop, steps: [advisory] },
      accepted: true,
    },
    {
      name: "accepts reworded service guidance",
      report: {
        ...noop,
        steps: [{ ...advisory, advisory: { ...advisory.advisory, message: "Rerun elsewhere." } }],
      },
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
        steps: [
          { ...advisory, name: "managed-service", command: "openclaw gateway status --deep" },
        ],
      },
    },
    {
      name: "rejects a different advisory kind",
      report: {
        ...noop,
        steps: [
          {
            ...advisory,
            advisory: { ...advisory.advisory, kind: "candidate-runtime-unavailable" },
          },
        ],
      },
    },
    {
      name: "rejects an unexplained advisory",
      report: {
        ...noop,
        steps: [{ ...advisory, advisory: { ...advisory.advisory, message: " " } }],
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

describe("legacy-operator final Doctor report", () => {
  it.each([
    { name: "accepts a clean report", status: 0, report: cleanDoctorReport, accepted: true },
    {
      name: "accepts the sole legacy-auth advisory",
      status: 1,
      report: legacyAuthDoctorReport,
      accepted: true,
    },
    {
      name: "rejects an additional warning",
      status: 1,
      report: {
        ...legacyAuthDoctorReport,
        findings: [
          legacyAuthWarning,
          { checkId: "core/doctor/other", severity: "warning", message: "Other warning." },
        ],
      },
    },
    {
      name: "rejects a different warning",
      status: 1,
      report: {
        ...legacyAuthDoctorReport,
        findings: [{ ...legacyAuthWarning, message: "Different warning." }],
      },
    },
    {
      name: "rejects an error",
      status: 1,
      report: {
        ...legacyAuthDoctorReport,
        findings: [{ ...legacyAuthWarning, severity: "error" }],
      },
    },
    {
      name: "rejects a command error",
      status: 2,
      report: legacyAuthDoctorReport,
    },
    {
      name: "rejects an advisory with a clean exit",
      status: 0,
      report: legacyAuthDoctorReport,
    },
    {
      name: "rejects a clean payload with a failing exit",
      status: 1,
      report: cleanDoctorReport,
    },
    {
      name: "rejects an unhealthy empty report",
      status: 0,
      report: { ...cleanDoctorReport, ok: false },
    },
    {
      name: "rejects a report that ran no checks",
      status: 0,
      report: { ...cleanDoctorReport, checksRun: 0 },
    },
  ])("$name", ({ report, status, accepted }) => {
    const result = checkDoctor(report, status);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(accepted ? 0 : 1);
  });

  it("still rejects a Gateway serving a different candidate", () => {
    const result = checkDoctor(cleanDoctorReport, 0, "2026.10.5");
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Gateway is not serving the candidate version");
  });
});
