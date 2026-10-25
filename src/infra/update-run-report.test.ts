import { afterEach, expect, it, vi } from "vitest";
import { isReportableUpdateRun } from "../shared/update-outcome-classification.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import * as reportHealth from "./update-run-report-health.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
  updateRunReportInputFromSentinel,
} from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

type ReportRecord = Parameters<typeof renderUpdateRunReport>[0] &
  Pick<UpdateRunRecord, "runId" | "trigger">;
function run(patch: Partial<ReportRecord> = {}): ReportRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    trigger: "cli",
    phase: "finished",
    status: "succeeded",
    reason: null,
    origin: {},
    target: { kind: "package" },
    before: { version: "2026.9.1" },
    after: { version: "2026.9.2" },
    steps: [{ step: "staging", status: "completed", startedAtMs: 1, endedAtMs: 301 }],
    verification: {},
    repair: [],
    downtimeMs: null,
    ...patch,
  };
}

function failed(patch: Partial<ReportRecord> = {}) {
  return run({ status: "failed", ...patch });
}

function failureReport(
  record: ReportRecord,
  result: Partial<UpdateRunResult> = {},
  recorded = true,
) {
  return prepareUpdateFailureReport(
    {
      attemptId: record.runId,
      ...(recorded ? { recordedRun: record } : {}),
      result: { status: "error", mode: "npm", steps: [], durationMs: 0, ...result },
    },
    { stateDir: "/fixture/state", env: {} },
  );
}

function resultStep(
  name: string,
  patch: Partial<UpdateRunResult["steps"][number]> = {},
): UpdateRunResult["steps"][number] {
  return { name, command: name, cwd: "/fixture", durationMs: 0, exitCode: 0, ...patch };
}

type Step = UpdateRunRecord["steps"][number];
function failedStep(step: string, patch: Partial<Step> = {}): Step {
  return { step, status: "failed", ...patch };
}

function expectChatBudget(markdown: string) {
  expect(markdown.length).toBeLessThanOrEqual(1500);
  expect(Buffer.from(markdown).toString("utf8")).toBe(markdown);
}

function expectText(text: string, contains: string[], excludes: string[] = []) {
  for (const part of contains) {
    expect(text).toContain(part);
  }
  for (const part of excludes) {
    expect(text).not.toContain(part);
  }
}

const recoveryStep = {
  step: "gateway recovery verification",
  status: "completed",
  exitCode: 0,
} as const;
function verified(version: string) {
  return { runningVersion: version, versionMatch: true, readyz: true, settled: true };
}
function healthy(version: string) {
  return { serviceRestartSafe: true, service: "healthy", version } as const;
}
type RecoveryReason = "state-migration-started" | "runtime-verification-failed";
function serving(version: string, reason: RecoveryReason) {
  return {
    ...verified(version),
    recovery: { serviceRestartSafe: false as const, reason },
  };
}

function renderRecord(record: ReportRecord, options?: Parameters<typeof renderUpdateRunReport>[1]) {
  const saved = structuredClone(record);
  record.steps.forEach(Object.freeze);
  Object.freeze(record.steps);
  Object.freeze(record);
  const report = renderUpdateRunReport(record, options);
  expect(record).toEqual(saved);
  return report;
}
function render(patch: Partial<ReportRecord>) {
  return renderRecord(run(patch));
}

afterEach(() => vi.restoreAllMocks());

it("reports repeated database-path advisories once across Doctor phases", () => {
  const detail =
    "Skipped agent database path repair during update Doctor. Run openclaw doctor --fix to repair agent database paths.";
  const report = render({
    steps: [
      { step: "warning:doctor", status: "completed", detail },
      { step: "activating", status: "completed" },
      { step: "warning:post-plugin-doctor", status: "completed", detail },
    ],
  });
  expect(report.lines.filter((line) => line.startsWith("Warning: "))).toEqual([
    `Warning: ${detail}`,
  ]);
  expect(report.headline).toContain("1 warning needs attention");
});
it.each([true, false])("bounds runtime guidance (saved=%s)", (saved) => {
  const action = `Keep the candidate installed and do not roll back code alone. ${"🦞".repeat(600)}`;
  const reason = saved ? "node-runtime-preflight" : "preflight-node-runtime-incompatible";
  const record = failed({
    reason,
    origin: saved ? { nextAction: action } : {},
    steps: [
      { step: "staging", status: "completed" },
      failedStep("preflight-node-runtime", {
        detail: "detail ".repeat(300),
        failureFacts: [{ check: "node-runtime", code: reason, affectedKey: "engines.node" }],
      }),
    ],
  });
  const report = renderRecord(record, saved ? {} : { nextAction: action });
  expect(report.headline).toBe(
    "⚠️ OpenClaw could not complete the update. A required system check failed.",
  );
  expect(report.lines.slice(1, 4)).toEqual(["", "Details:", `Reason code: ${reason}`]);
  expect(report.lines).toContain(`Failing check node-runtime (${reason}); key engines.node`);
  expect(report.lines).toContain("Phases: staging");
  expectChatBudget(report.markdown);
  expectText(report.markdown, [
    "Keep the candidate installed and do not roll back code alone.",
    `Reason code: ${reason}`,
  ]);
  expect(report.lines.join("\n")).toContain(action);
  expect(report.markdown.includes("Historical recovery advice:")).toBe(saved);
});

it.each([true, false])("separates saved and current health (responding=%s)", (responding) => {
  const record = failed({
    reason: "node-runtime-preflight",
    origin: responding
      ? {
          nextAction:
            "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds. Keep the candidate installed and do not roll back code alone.",
        }
      : {},
    steps: [recoveryStep],
    verification: {
      serviceRunning: true,
      runningVersion: "2026.9.1",
      versionMatch: true,
      readyz: true,
      channelsReady: false,
      recovery: healthy("2026.9.1"),
    },
  });
  const currentHealth = responding
    ? { kind: "responding" as const, version: "2026.9.2" }
    : { kind: "unavailable" as const };
  const report = renderRecord(record, { currentHealth });
  expectText(report.markdown, [
    "Recorded recovery: verified serving 2026.9.1.",
    "Recorded verification: service running (2026.9.1); version verified; channels not ready; HTTP ready.",
    responding
      ? "Current health: Gateway answered on the recorded port (2026.9.2)."
      : "Current health unavailable; saved verification describes the update attempt only.",
  ]);
  expect(report.markdown.includes("Historical recovery advice:")).toBe(responding);
  if (responding) {
    expect(report.lines).not.toContain(record.origin.nextAction);
    expectText(report.markdown, [
      "supersedes saved claims that the Gateway is stopped",
      "Keep the candidate installed and do not roll back code alone.",
    ]);
    expect(report.markdown.endsWith(record.origin.nextAction!)).toBe(false);
  }
  expect(report.headline).not.toContain("gateway is running");
  expect(report.markdown).not.toContain("chat");
});

it.each(["state-migration-started", "runtime-verification-failed"] as const)(
  "retains %s constraints",
  async (reason) => {
    const record = failed({
      reason: "post-update-plugins",
      steps: [recoveryStep],
      verification: serving("2026.9.5", reason),
    });
    const expected = `verified serving 2026.9.5; restart remains unsafe (${reason})`;
    expect(renderUpdateRunReport(record).markdown).toContain(expected);
    const report = await failureReport(
      record,
      reason === "runtime-verification-failed"
        ? {
            verification: verified("2026.9.5"),
            recovery: healthy("2026.9.5"),
            steps: [resultStep("gateway recovery verification", { command: "verify" })],
          }
        : {},
    );
    expect(report.body).toContain(`Recovery outcome: ${expected}`);
    expect(record.verification.recovery?.serviceRestartSafe).toBe(false);
  },
);

it.each([
  ["target", "runtime-verification-failed", true],
  ["previous", "runtime-verification-failed", false],
  ["unavailable", "runtime-verification-failed", false],
  ["unknown-target", "runtime-verification-failed", false],
  ["target", "state-migration-started", false],
] as const)("reconciles %s (%s)", (health, reason, recovered) => {
  const record = failed({
    reason: "state-migrated-no-rollback",
    after: health === "unknown-target" ? {} : { version: "2026.9.2" },
    origin: {
      nextAction: `Your Gateway is still serving 2026.9.1; nothing to restore. Restart remains unsafe (${reason}). Keep the new installation and recovery snapshots; do not roll back code alone.`,
    },
    steps: [recoveryStep],
    verification: serving("2026.9.1", reason),
  });
  const report = renderRecord(record, {
    currentHealth:
      health === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "responding", version: health === "previous" ? "2026.9.1" : "2026.9.2" },
  });
  expect(report.headline).toContain("update failed: state-migrated-no-rollback");
  if (recovered) {
    expectText(
      report.markdown,
      [
        "Current health: Gateway answered on the recorded port (2026.9.2).",
        "saved runtime verification failure no longer applies",
        "Keep the new installation and backups",
        "rolling back code alone is unsafe",
      ],
      [
        "runtime-verification-failed",
        "restart remains unsafe",
        "Restart remains unsafe",
        "Historical recovery advice",
      ],
    );
  } else {
    expectText(report.markdown, [
      `restart remains unsafe (${reason})`,
      "Historical recovery advice",
      "recovery snapshots",
      "do not roll back code alone",
    ]);
  }
});

it.each([
  ["external-supervisor-update-required", "Use your server or deployment's update workflow"],
  ["container-image-install", "Pull or build the target Docker/container image"],
  ["unmanaged-package-install", "Reinstall using the original method"],
  ["package-update-requires-cli", "through this install's npm, pnpm, or Bun global launcher"],
])("explains skipped %s", (reason, nextAction) => {
  const record = run({
    status: "skipped",
    reason,
    origin: { doctorHint: "Run openclaw doctor --non-interactive" },
    after: {},
    steps: [],
  });

  const report = renderUpdateRunReport(record);
  expectText(
    report.markdown,
    [nextAction, "No package changes or Gateway restart were attempted"],
    ["openclaw triage", "openclaw doctor"],
  );
  expect(isReportableUpdateRun(record)).toBe(false);
});

it.each([
  ["abandoned", "completed", true],
  ["legacy-driver-expired", "completed", true],
  [null, "completed", false],
  ["abandoned", "in_progress", false],
] as const)("requires acknowledgement (%s, %s)", (reason, acknowledgement, reconciled) => {
  const record = failed({
    reason,
    origin: { doctorHint: "Run openclaw doctor --fix", nextAction: "Run openclaw triage" },
    steps: [
      failedStep("requested"),
      failedStep("finalize:doctor"),
      failedStep("reconcile:abandoned", { detail: "inactive-driver-dead" }),
      { step: "reconcile:acknowledged", status: acknowledgement, endedAtMs: 301 },
    ],
  });
  const report = renderRecord(record);
  expect(report.headline).toBe(
    reconciled
      ? "ℹ️ OpenClaw abandoned update reconciled."
      : `⚠️ OpenClaw update failed: ${reason?.trim() || "finalize:doctor"}.`,
  );
  for (const line of ["finalize:doctor", "reconcile:abandoned — inactive-driver-dead"]) {
    expect(report.lines).toContain(`Failed: ${line}`);
  }
  expect(report.markdown.includes("Run openclaw")).toBe(!reconciled);
  if (reconciled) {
    expect(report.markdown).not.toContain("to retry");
  } else {
    expect(report.markdown).toContain("Run openclaw triage");
  }
});

it.each([
  ["private-customer-build", false],
  ["2026.9.4-private-customer", true],
] as const)("redacts %s (observed=%s)", async (version, observed) => {
  vi.spyOn(reportHealth, "readUpdateRunReportHealth").mockResolvedValue({
    kind: "responding",
    version,
  });
  const record = failed({
    ...(observed ? { steps: [recoveryStep] } : {}),
    verification: observed
      ? { port: 19123, ...verified(version), recovery: healthy(version) }
      : { port: 19123, versionMatch: false },
  });
  const report = await failureReport(record);
  expect(report.body).toContain(
    `Recorded verification: ${observed ? "version verified" : "service identity unavailable"}`,
  );
  if (observed) {
    expect(report.body).toContain("Recovery outcome: verified serving [redacted-version]");
  }
  expectText(
    report.body,
    [
      "Current health: Gateway answered on the recorded port ([redacted-version]).",
      "not a current instruction to stop or restart",
    ],
    [version],
  );
});

it.each<[UpdateRunRecord["verification"], string, boolean?]>([
  [{ runningVersion: "2026.9.1", versionMatch: false }, "version mismatch"],
  [
    { runningVersion: "2026.9.2", runningBuildId: "older-build", versionMatch: false },
    "build mismatch",
  ],
  [{ runningVersion: "2026.9.2", versionMatch: false }, "service identity unavailable"],
  [
    { serviceRunning: true, versionMatch: false },
    "service running; service identity unavailable",
    true,
  ],
])("reports identity (%j, %s)", async (verification, expected, publicReport) => {
  const record = failed({
    reason: "restart-unhealthy",
    after: { version: "2026.9.2", buildId: "candidate-build" },
    verification,
  });
  const report = renderUpdateRunReport(record);
  expect(report.lines).toContain(`Recorded verification: ${expected}.`);
  if (publicReport) {
    const failure = await failureReport(record);
    for (const text of [report.markdown, failure.body]) {
      expectText(text, ["identity unavailable"], ["version mismatch"]);
    }
  }
});

it.each(["status", "failure"])("reports legacy expiry (%s)", async (surface) => {
  const record = failed({ reason: "legacy-driver-expired" });
  const text =
    surface === "status"
      ? renderUpdateRunReport(record).markdown
      : (await failureReport(record, { mode: "unknown", reason: "legacy-driver-expired" }, false))
          .body;
  expect(text).toContain(
    "A 2026.9.2-era update never progressed past admission; treated as abandoned after 24 h; run `openclaw update` to retry.",
  );
});

it.each([
  [true, "2026.9.7 (9f3c21a0) (from 2026.9.6 (11111111))"],
  [false, "9f3c21a0 (from 11111111)"],
] as const)("identifies revisions (version=%s)", (version, expected) => {
  const report = render({
    before: { sha: "1".repeat(40), ...(version ? { version: "2026.9.6" } : {}) },
    after: { sha: `9f3c21a${"0".repeat(31)}aa`, ...(version ? { version: "2026.9.7" } : {}) },
  });
  expect(report.headline).toBe(`✅ OpenClaw updated to ${expected}.`);
  expect(report.markdown).toContain(report.headline);
  expect(report.lines).toContain("Phases: staging (300ms)");
});

it("bounds chat failures but preserves full CLI guidance", () => {
  const report = render({
    status: "failed",
    reason: "post-update-failed",
    steps: Array.from({ length: 5 }, (_, index) =>
      failedStep(`build-${index}`, { detail: "🦞".repeat(500) }),
    ),
    repair: Array.from({ length: 3 }, (_, index) => ({
      attempt: index + 1,
      status: "failed",
      startedAtMs: 1,
      summary: "repair detail ".repeat(100),
    })),
    origin: { doctorHint: "Recovery instructions ".repeat(80) },
  });
  const failures = report.lines.filter((line) => line.startsWith("Failed:"));
  expect(failures).toHaveLength(3);
  expect(failures.map((line) => line.split(" — ")[0])).toEqual([
    "Failed: build-2",
    "Failed: build-3",
    "Failed: build-4",
  ]);
  expect(failures.every((line) => line.length <= 300)).toBe(true);
  expectChatBudget(report.markdown);
  expect(
    report.markdown.endsWith("Run openclaw triage to diagnose and repair the failed update."),
  ).toBe(true);
  expect(report.lines.join("\n").length).toBeGreaterThan(1500);
});

const originAction = "Run `openclaw --profile work triage` to repair this installation.";
const selectedAction = "Run `openclaw --profile team triage` to repair this installation.";
type RecoveryCase = [
  string | Partial<ReportRecord>,
  string[],
  string[]?,
  Parameters<typeof renderUpdateRunReport>[1]?,
];
const defaultAdvice = [
  "Run openclaw triage",
  "run openclaw doctor --fix",
  "operator can run openclaw triage locally",
];
it.each<RecoveryCase>([
  ["node-runtime-preflight", ["Reason code: node-runtime-preflight", "Run openclaw triage"]],
  [
    { reason: "node-runtime-preflight", target: { kind: "package", installationMethod: "ocm" } },
    ["Reason code: node-runtime-preflight"],
    ["Run openclaw triage"],
  ],
  ["preflight-insufficient-space", ["Free space on the preflight staging"]],
  ...[
    { reason: "state-migrated-no-rollback" },
    {
      reason: "post-install-verify",
      verification: {
        rollbackOutcome: {
          status: "not-attempted" as const,
          reason: "state-migrated-no-rollback",
        },
      },
    },
  ].map((patch): RecoveryCase => [
    patch,
    [
      "State may have changed during migration, so rolling back code alone is unsafe.",
      "Keep the new installation and backups",
      "openclaw update status",
      "openclaw doctor",
    ],
    ["Run openclaw triage"],
  ]),
  ...(
    [
      ["requester-revoked", "A current command owner must start a new update"],
      ["repair-requires-config-change", "run openclaw doctor --fix under your own authority"],
    ] as const
  ).map(([reason, advice]): RecoveryCase => [
    {
      reason: "doctor-failed",
      repair: [{ attempt: 1, status: "failed", startedAtMs: 1, reason }],
    },
    [reason, advice],
  ]),
  ...[null, "requester-revoked", "state-migrated-no-rollback"].map((reason): RecoveryCase => [
    { reason, origin: { nextAction: originAction } },
    [
      "Historical recovery advice:",
      originAction,
      ...(reason === "requester-revoked"
        ? ["Further recovery requires a current command owner."]
        : []),
    ],
    [...defaultAdvice, "State may have changed during migration"],
  ]),
  [
    { reason: "repair-requires-config-change", origin: { nextAction: originAction } },
    ["Doctor could not promote config changes."],
    [originAction, ...defaultAdvice],
    { nextAction: selectedAction },
  ],
])("preserves recovery ownership: %j", (input, contains, excludes, options) => {
  const patch = typeof input === "string" ? { reason: input } : input;
  const report = renderUpdateRunReport(failed(patch), options);
  expectText(report.markdown, contains, excludes);
  if (patch.origin?.nextAction && !options?.nextAction) {
    expect(report.lines).not.toContain(originAction);
  }
  if (options?.nextAction) {
    expect(report.lines.at(-1)).toBe(selectedAction);
    expect(report.markdown.endsWith(selectedAction)).toBe(true);
  }
});

it("separates advisories from multiline failures", () => {
  const report = renderUpdateRunReport(
    updateRunReportInputFromResult({
      status: "error",
      mode: "npm",
      durationMs: 1,
      steps: [
        resultStep("openclaw doctor", {
          exitCode: 1,
          advisory: {
            kind: "package-post-install-doctor",
            message: "A plugin repair is deferred",
          },
        }),
        resultStep("build", {
          exitCode: 1,
          termination: "timeout",
          stdoutTail: "earlier output\nlast build diagnostic",
          stderrTail: "earlier error\nlast error diagnostic",
          failureFacts: [
            { check: "build", code: "build-failed", message: "last error diagnostic" },
          ],
        }),
      ],
    }),
  );
  expect(report.lines.filter((line) => line.startsWith("Failed:"))).toEqual([
    "Failed: build — timeout; last build diagnostic; last error diagnostic",
  ]);
});

it.each([
  ["Failed", "Permission denied", false],
  ["Permission denied", "Permission denied", true],
  ["Permission denied", `${"x".repeat(300)} Permission denied`, false],
] as const)("deduplicates visible facts (%s, %s, %s)", (message, detail, repeated) => {
  const report = render({
    status: "failed",
    steps: [
      failedStep("package-swap", {
        detail,
        failureFacts: [{ check: "package-swap", code: "swap-failed", message }],
      }),
    ],
  });
  expect(report.lines).toContain(
    `Failing check package-swap (swap-failed)${repeated ? "" : `: ${message}`}`,
  );
});

it("does not infer success from pending, stopped, or legacy facts", () => {
  const report = render({
    status: "running",
    phase: "verifying",
    after: {},
    origin: { doctorHint: "Run openclaw doctor", nextAction: "Run the update manually" },
    verification: {
      booted: true,
      versionMatch: false,
      channelsReady: false,
      pluginErrors: ["Activation failed"],
    },
    repair: [{ attempt: 1, status: "failed", startedAtMs: 1, summary: "Plugin still unavailable" }],
  });
  expect(report.headline).toBe("⬆️ OpenClaw update in progress: verifying.");
  expectText(
    report.markdown,
    [
      "service identity unavailable; channels not ready; 1 plugin activation error(s)",
      "Repair 1: failed — Plugin still unavailable",
    ],
    ["openclaw doctor", "Run the update manually", "The gateway is running"],
  );
  const stopped = render({
    status: "failed",
    verification: { serviceRunning: false, runningVersion: "2026.9.1" },
  });
  expect(stopped.headline).not.toContain("The gateway is running");
  expect(stopped.lines).toContain("Recorded verification: service stopped.");
  const legacy = renderUpdateRunReport(
    updateRunReportInputFromSentinel({
      kind: "update",
      status: "error",
      ts: 1,
      stats: {
        steps: [
          {
            name: "build",
            command: "pnpm build",
            log: {
              exitCode: 1,
              stdoutTail: "private legacy output",
              stderrTail: "private legacy error",
            },
          },
        ],
      },
    }),
  );
  expectText(legacy.markdown, ["Failed: build"], ["private legacy"]);
});

it.each<[string | null, string[], string]>([
  [" saved-doctor-error ", ["finalize:doctor"], "saved-doctor-error"],
  [null, ["requested"], "unknown reason"],
  ["  ", ["requested", "finalize:doctor", "finalize:plugins"], "finalize:doctor"],
  [null, [`${"x".repeat(238)}🦞${"y".repeat(300)}`], `${"x".repeat(238)}…`],
])("bounds reasons: %s, %j, %s", (reason, failedSteps, expected) => {
  const record = failed({
    reason,
    steps: [
      { step: "staging", status: "completed" },
      ...failedSteps.map((step) => failedStep(step)),
    ],
  });
  const report = renderRecord(record);
  expect(report.headline).toBe(`⚠️ OpenClaw update failed: ${expected}.`);
  expect(report.headline.length).toBeLessThanOrEqual(500);
  expectChatBudget(report.markdown);
});

it.each<[UpdateRunRecord["status"], string | null, string]>([
  ["succeeded", null, "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1)."],
  ["running", null, "⬆️ OpenClaw update in progress: verifying."],
  ["skipped", null, "ℹ️ OpenClaw update skipped: unknown reason."],
  ["rolled-back", null, "↩️ OpenClaw update rolled back to 2026.9.2: unknown reason."],
  [
    "skipped",
    "gateway-readiness-unverified",
    "ℹ️ OpenClaw 2026.9.2 installed; Gateway readiness unverified; recovery backups retained.",
  ],
  [
    "skipped",
    "still-starting",
    "ℹ️ OpenClaw 2026.9.2 installed; Gateway still starting; readiness unverified; recovery backups retained.",
  ],
])("keeps %s headline despite failed children (%s)", (status, reason, headline) => {
  const record = run({ status, reason, phase: "verifying" });
  expect(renderUpdateRunReport(record).headline).toBe(headline);
  const report = renderUpdateRunReport({ ...record, steps: [failedStep("finalize:doctor")] });
  expect(report.headline).toBe(headline);
  expect(report.headline).not.toContain("finalize:doctor");
});
