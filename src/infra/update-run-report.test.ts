import { afterEach, describe, expect, it, vi } from "vitest";
import { isReportableUpdateRun } from "../shared/update-outcome.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import * as reportHealth from "./update-run-report-health.js";
import {
  renderUpdateRunNotice,
  renderUpdateRunReport,
  updateRunReportInputFromResult,
  updateRunReportInputFromSentinel,
} from "./update-run-report.js";

function run(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 301,
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
    confirmedAtMs: null,
    finishedAtMs: 301,
    downtimeMs: null,
    ...patch,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("update run report", () => {
  it.each(
    (["state-migration-started", "runtime-verification-failed"] as const).flatMap((reason) =>
      [false, true].map((raw) => ({ reason, raw })),
    ),
  )("reports serving health with its $reason constraint (raw=$raw)", async ({ reason, raw }) => {
    const record = run({
      status: "failed",
      reason: "post-update-plugins",
      steps: [{ step: "gateway recovery verification", status: "completed", exitCode: 0 }],
      verification: {
        runningVersion: "2026.9.5",
        versionMatch: true,
        readyz: true,
        settled: true,
        recovery: { serviceRestartSafe: false, reason },
      },
    });
    const expected = `verified serving 2026.9.5; restart remains unsafe (${reason})`;
    expect(renderUpdateRunReport(record).markdown).toContain(expected);
    const report = await prepareUpdateFailureReport(
      {
        attemptId: record.runId,
        recordedRun: record,
        result: {
          status: "error",
          mode: "npm",
          durationMs: 0,
          ...(raw
            ? {
                verification: {
                  runningVersion: "2026.9.5",
                  versionMatch: true,
                  readyz: true,
                  settled: true,
                },
                recovery: {
                  serviceRestartSafe: true as const,
                  service: "healthy" as const,
                  version: "2026.9.5",
                },
              }
            : {}),
          steps: raw
            ? [
                {
                  name: "gateway recovery verification",
                  command: "verify",
                  cwd: "/fixture",
                  durationMs: 0,
                  exitCode: 0,
                },
              ]
            : [],
        },
      },
      { stateDir: "/fixture/state", env: {} },
    );
    expect(report.body).toContain(`Recovery outcome: ${expected}`);
    expect(record.verification.recovery?.serviceRestartSafe).toBe(false);
  });

  it.each([
    ["external-supervisor-update-required", "Use your server or deployment's update workflow"],
    ["container-image-install", "Pull or build the target Docker/container image"],
    ["unmanaged-package-install", "Reinstall using the original method"],
    ["package-update-requires-cli", "through this install's npm, pnpm, or Bun global launcher"],
  ])("explains %s without treating it as a failed install", (reason, nextAction) => {
    const record = run({
      status: "skipped",
      reason,
      origin: { doctorHint: "Run openclaw doctor --non-interactive" },
      after: {},
      steps: [],
    });

    const report = renderUpdateRunReport(record);
    expect(report.markdown).toContain(nextAction);
    expect(report.markdown).toContain("No package changes or Gateway restart were attempted");
    expect(report.markdown).not.toContain("openclaw triage");
    expect(report.markdown).not.toContain("openclaw doctor");
    expect(isReportableUpdateRun(record)).toBe(false);
  });

  it.each(["abandoned", "legacy-driver-expired"])(
    "shows acknowledged %s recovery without discarding historical failure facts",
    (reason) => {
      const record = run({
        status: "failed",
        reason,
        origin: { doctorHint: "Run openclaw doctor --fix", nextAction: "Run openclaw triage" },
        steps: [
          { step: "reconcile:abandoned", status: "failed", detail: "inactive-driver-dead" },
          { step: "reconcile:acknowledged", status: "completed", endedAtMs: 301 },
        ],
      });
      const before = structuredClone(record);
      const report = renderUpdateRunReport(record);

      expect(report.headline).toBe("ℹ️ OpenClaw abandoned update reconciled.");
      expect(report.lines).toContain("Failed: reconcile:abandoned — inactive-driver-dead");
      expect(report.markdown).not.toContain("Run openclaw");
      expect(report.markdown).not.toContain("to retry");
      expect(record).toEqual(before);
    },
  );

  it.each(["in_progress", "failed"] as const)(
    "does not report an abandoned update as reconciled after %s acknowledgement",
    (status) => {
      const report = renderUpdateRunReport(
        run({
          status: "failed",
          reason: "abandoned",
          steps: [{ step: "reconcile:acknowledged", status }],
        }),
      );
      expect(report.headline).toBe("⚠️ OpenClaw update failed: abandoned.");
      expect(report.markdown).toContain("Run openclaw triage");
    },
  );

  it.each(
    ["private-customer-build", "2026.9.4-private-customer"].flatMap((version) =>
      [false, true].map((observed) => ({ version, observed })),
    ),
  )(
    "redacts the private current version $version in public reports (recovery=$observed)",
    async ({ version, observed }) => {
      vi.spyOn(reportHealth, "readUpdateRunReportHealth").mockResolvedValue({
        kind: "responding",
        version,
      });
      const record = run({
        status: "failed",
        ...(observed
          ? { steps: [{ step: "gateway recovery verification", status: "completed", exitCode: 0 }] }
          : {}),
        verification: {
          versionMatch: observed,
          port: 19123,
          ...(observed
            ? {
                runningVersion: version,
                readyz: true,
                settled: true,
                recovery: { serviceRestartSafe: true, service: "healthy", version },
              }
            : {}),
        },
      });
      const report = await prepareUpdateFailureReport(
        {
          attemptId: record.runId,
          recordedRun: record,
          result: { status: "error", mode: "npm", steps: [], durationMs: 0 },
        },
        { stateDir: "/fixture/state", env: {} },
      );
      expect(report.body).toContain(
        `Recorded verification: ${observed ? "version verified" : "service identity unavailable"}`,
      );
      if (observed) {
        expect(report.body).toContain("Recovery outcome: verified serving [redacted-version]");
      }
      expect(report.body).toContain(
        "Current health: Gateway answered on the recorded port ([redacted-version]).",
      );
      expect(report.body).toContain("not a current instruction to stop or restart");
      expect(report.body).not.toContain(version);
    },
  );

  it.each([
    { runningVersion: "2026.9.1", runningBuildId: undefined, expected: "version mismatch" },
    { runningVersion: "2026.9.2", runningBuildId: "older-build", expected: "build mismatch" },
    {
      runningVersion: "2026.9.2",
      runningBuildId: undefined,
      expected: "service identity unavailable",
    },
  ])("reports only observed disagreement ($expected)", ({ expected, ...observed }) => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        after: { version: "2026.9.2", buildId: "candidate-build" },
        verification: { ...observed, versionMatch: false },
      }),
    );
    expect(report.lines).toContain(`Verification: ${expected}.`);
  });

  it.each(["report", "notice", "failure"])(
    "reports an unreadable identity as unavailable in the %s surface",
    async (surface) => {
      const record = run({
        status: "failed",
        reason: "restart-unhealthy",
        verification: { serviceRunning: true, versionMatch: false },
      });
      const text =
        surface === "failure"
          ? (
              await prepareUpdateFailureReport(
                {
                  attemptId: record.runId,
                  recordedRun: record,
                  result: { status: "error", mode: "npm", steps: [], durationMs: 0 },
                },
                { stateDir: "/fixture/state", env: {} },
              )
            ).body
          : surface === "notice"
            ? renderUpdateRunNotice(record, "finished")
            : renderUpdateRunReport(record).markdown;
      expect(text).toContain("identity unavailable");
      expect(text).not.toContain("version mismatch");
    },
  );

  it("qualifies saved stopped advice against a current health observation without losing constraints", () => {
    const advice =
      "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds. Keep the candidate installed and do not roll back code alone.";
    const record = run({
      status: "failed",
      reason: "restart-unhealthy",
      origin: { nextAction: advice },
      verification: { serviceRunning: false, versionMatch: false },
    });
    const options = {
      nextAction: undefined,
      currentHealth: { kind: "responding" as const, version: "2026.9.2" },
    };
    const report = renderUpdateRunReport(record, options);
    expect(report.lines).not.toContain(advice);
    expect(report.markdown).toContain(
      "Current health: Gateway answered on the recorded port (2026.9.2).",
    );
    expect(report.markdown).toContain("supersedes saved claims that the Gateway is stopped");
    expect(report.markdown).toContain(
      "Keep the candidate installed and do not roll back code alone.",
    );
    expect(report.markdown.endsWith(advice)).toBe(false);
    expect(record.origin.nextAction).toBe(advice);
    expect(record.status).toBe("failed");
  });

  it.each(["status", "failure"])(
    "includes the legacy expiry advisory in the %s report",
    async (surface) => {
      const record = run({ status: "failed", reason: "legacy-driver-expired" });
      const text =
        surface === "status"
          ? renderUpdateRunReport(record).markdown
          : (
              await prepareUpdateFailureReport(
                {
                  attemptId: record.runId,
                  result: {
                    status: "error",
                    mode: "unknown",
                    reason: record.reason ?? undefined,
                    steps: [],
                    durationMs: 0,
                  },
                },
                { stateDir: "/fixture/state", env: {} },
              )
            ).body;
      expect(text).toContain(
        "A 2026.9.2-era update never progressed past admission; treated as abandoned after 24 h; run `openclaw update` to retry.",
      );
    },
  );

  it.each([
    ["requester-revoked", "A current command owner must start a new update"],
    ["repair-requires-config-change", "run openclaw doctor --fix under your own authority"],
  ])("renders the repair stop reason %s with an unambiguous next action", (reason, guidance) => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "doctor-failed",
        repair: [{ attempt: 1, status: "failed", startedAtMs: 1, reason }],
      }),
    );
    expect(report.markdown).toContain(reason);
    expect(report.markdown).toContain(guidance);
  });

  it("limits parking notices to the pre-updater milestone without loosening phase notices", () => {
    const requested = run({ status: "running", phase: "requested" });
    expect(renderUpdateRunNotice(requested, "parking")).toContain("Restarting the gateway now");
    expect(renderUpdateRunNotice(requested, "activating")).toBeNull();
    expect(renderUpdateRunNotice(requested, "verifying")).toBeNull();
    for (const phase of ["staging", "activating", "verifying"] as const) {
      const progressed = run({ status: "running", phase });
      expect(renderUpdateRunNotice(progressed, "parking")).toBeNull();
      expect(renderUpdateRunNotice(progressed, "ack")).toBeNull();
    }
    expect(renderUpdateRunNotice(run(), "parking")).toBeNull();
  });

  it("reports changed git commits when the package version stays the same", () => {
    const report = renderUpdateRunReport(
      run({
        before: { version: "2026.8.1", sha: "1111111111111111111111111111111111111111" },
        after: { version: "2026.8.1", sha: "9f3c21a0000000000000000000000000000000aa" },
      }),
    );
    expect(report.headline).toBe("✅ OpenClaw updated to 9f3c21a0 (from 11111111).");
    expect(report.markdown).toContain(report.headline);
  });

  it("distinguishes all terminal outcomes without claiming unobserved verification", () => {
    const reports = [
      run(),
      run({
        status: "failed",
        reason: "restart-unhealthy",
        verification: { runningVersion: "2026.9.1", serviceRunning: true },
      }),
      run({ status: "skipped", reason: "dry-run", after: {} }),
      run({ status: "rolled-back", reason: "build-failed", after: { version: "2026.9.1" } }),
    ].map((record) => renderUpdateRunReport(record).markdown);
    expect(reports).toMatchInlineSnapshot(`
      [
        "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).
      Phases: staging (300ms)",
        "⚠️ OpenClaw update failed: restart-unhealthy. The gateway is running 2026.9.1.
      Phases: staging (300ms)
      Verification: service running.
      Run openclaw triage to diagnose and repair the failed update.",
        "ℹ️ OpenClaw update skipped: dry-run.
      Phases: staging (300ms)",
        "↩️ OpenClaw update rolled back to 2026.9.1: build-failed.
      Phases: staging (300ms)",
      ]
    `);
  });

  it("keeps recent failures and next action within the chat budget without truncating CLI guidance", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "post-update-failed",
        steps: Array.from({ length: 5 }, (_, index) => ({
          step: `build-${index}`,
          status: "failed",
          detail: "🦞".repeat(500),
        })),
        repair: Array.from({ length: 3 }, (_, index) => ({
          attempt: index + 1,
          status: "failed",
          startedAtMs: 1,
          summary: "repair detail ".repeat(100),
        })),
        origin: { doctorHint: "Recovery instructions ".repeat(80) },
      }),
    );
    const failures = report.lines.filter((line) => line.startsWith("Failed:"));
    expect(failures).toHaveLength(3);
    expect(failures.map((line) => line.split(" — ")[0])).toEqual([
      "Failed: build-2",
      "Failed: build-3",
      "Failed: build-4",
    ]);
    expect(failures.every((line) => line.length <= 300)).toBe(true);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    expect(Buffer.from(report.markdown).toString("utf8")).toBe(report.markdown);
    expect(
      report.markdown.endsWith("Run openclaw triage to diagnose and repair the failed update."),
    ).toBe(true);
    expect(report.lines.join("\n").length).toBeGreaterThan(1500);
  });

  it.each([
    ["preflight-insufficient-space", "Free space on the preflight staging"],
    ["pnpm-corepack-missing", "corepack is missing"],
    ["pnpm-corepack-enable-failed", "corepack enable"],
    ["pnpm-npm-bootstrap-failed", "bootstrap pnpm from npm"],
    ["preferred-manager-unavailable", "declared package manager"],
  ])("preserves recovery guidance for %s", (reason, hint) => {
    expect(renderUpdateRunReport(run({ status: "failed", reason })).markdown).toContain(hint);
  });

  it.each([
    { reason: null, source: "origin" },
    { reason: "requester-revoked", source: "origin" },
    { reason: "repair-requires-config-change", source: "origin" },
    { reason: "requester-revoked", source: "options" },
    { reason: "repair-requires-config-change", source: "options" },
  ])("keeps $source recovery scoped to its profile after $reason", ({ reason, source }) => {
    const originAction = "Run `openclaw --profile work triage` to repair this installation.";
    const nextAction =
      source === "options"
        ? "Run `openclaw --profile team triage` to repair this installation."
        : originAction;
    const report = renderUpdateRunReport(
      run({ status: "failed", reason, origin: { nextAction: originAction } }),
      source === "options" ? { nextAction } : {},
    );
    if (source === "options") {
      expect(report.lines.at(-1)).toBe(nextAction);
      expect(report.markdown.endsWith(nextAction)).toBe(true);
    } else {
      expect(report.lines).not.toContain(nextAction);
      expect(report.markdown).toContain("Historical recovery advice:");
      expect(report.markdown).toContain(nextAction);
    }
    expect(report.markdown).not.toContain("Run openclaw triage");
    expect(report.markdown).not.toContain("run openclaw doctor --fix");
    expect(report.markdown).not.toContain("operator can run openclaw triage locally");
    if (source === "options") {
      expect(report.markdown).not.toContain(originAction);
    }
    if (reason === "requester-revoked") {
      expect(report.markdown).toContain("Further recovery requires a current command owner.");
    } else if (reason === "repair-requires-config-change") {
      expect(report.markdown).toContain("Doctor could not promote config changes.");
    }
  });

  it("keeps advisory steps out of failures and shows only the final diagnostic lines", () => {
    const report = renderUpdateRunReport(
      updateRunReportInputFromResult({
        status: "error",
        mode: "npm",
        durationMs: 1,
        steps: [
          {
            name: "openclaw doctor",
            command: "openclaw doctor",
            cwd: "/tmp",
            durationMs: 1,
            exitCode: 1,
            advisory: {
              kind: "package-post-install-doctor",
              message: "A plugin repair is deferred",
            },
          },
          {
            name: "build",
            command: "pnpm build",
            cwd: "/tmp",
            durationMs: 1,
            exitCode: 1,
            termination: "timeout",
            stdoutTail: "earlier output\nlast build diagnostic",
            stderrTail: "earlier error\nlast error diagnostic",
          },
        ],
      }),
    );
    expect(report.lines.filter((line) => line.startsWith("Failed:"))).toEqual([
      "Failed: build — timeout; last build diagnostic; last error diagnostic",
    ]);
  });

  it.each([
    "Update refused: agent database /state/agents/main/agent.sqlite has schema 20; target supports 19; writer build 2026.9.4.",
    "Update refused: could not inspect state database /state/state.sqlite: ENOSPC: no space left on device; retry once the gateway releases it.",
  ])("keeps the schema preflight cause instead of its generic footer: %s", (cause) => {
    const report = renderUpdateRunReport(
      updateRunReportInputFromResult({
        status: "error",
        reason: "database-schema-preflight",
        mode: "npm",
        durationMs: 1,
        steps: [
          {
            name: "database-schema-preflight",
            command: "openclaw update",
            cwd: "/tmp",
            durationMs: 1,
            exitCode: 1,
            stderrTail: [
              cause,
              "https://docs.openclaw.ai/reference/database-schemas",
              "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
            ].join("\n"),
          },
        ],
      }),
    );
    expect(report.markdown).toContain(cause);
    expect(report.markdown).not.toContain("Installing manually via npm");
  });

  it("reports pending work, verification, and repair facts without inferring success", () => {
    const report = renderUpdateRunReport(
      run({
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
        repair: [
          { attempt: 1, status: "failed", startedAtMs: 1, summary: "Plugin still unavailable" },
        ],
      }),
    );
    expect(report.headline).toBe("⬆️ OpenClaw update in progress: verifying.");
    expect(report.markdown).not.toContain("openclaw doctor");
    expect(report.markdown).not.toContain("Run the update manually");
    expect(report.markdown).toContain(
      "service identity unavailable; channels not ready; 1 plugin activation error(s)",
    );
    expect(report.markdown).toContain("Repair 1: failed — Plugin still unavailable");
    expect(report.markdown).not.toContain("The gateway is running");
    const stopped = renderUpdateRunReport(
      run({
        status: "failed",
        verification: { serviceRunning: false, runningVersion: "2026.9.1" },
      }),
    );
    expect(stopped.headline).not.toContain("The gateway is running");
    expect(stopped.lines).toContain("Verification: service stopped.");
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
    expect(legacy.markdown).toContain("Failed: build");
    expect(legacy.markdown).not.toContain("private legacy");
  });

  it("uses the failed finalize step instead of unknown reason when reason is missing", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: null,
        steps: [
          { step: "requested", status: "failed", startedAtMs: 1, endedAtMs: 2 },
          { step: "finalize:doctor", status: "failed", startedAtMs: 1, endedAtMs: 2 },
        ],
      }),
    );
    expect(report.headline).toContain("finalize:doctor");
    expect(report.headline).not.toContain("unknown reason");
  });

  it.each([
    {
      reason: " saved-doctor-error ",
      failedSteps: ["finalize:doctor"],
      expected: "saved-doctor-error",
    },
    { reason: null, failedSteps: [], expected: "unknown reason" },
    { reason: null, failedSteps: ["requested"], expected: "unknown reason" },
  ])("preserves the update status headline for $expected", ({ reason, failedSteps, expected }) => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason,
        steps: [
          { step: "staging", status: "completed" },
          ...failedSteps.map((step) => ({ step, status: "failed" as const })),
        ],
      }),
    );
    expect(report.headline).toBe(`⚠️ OpenClaw update failed: ${expected}.`);
  });

  it.each(["skipped", "rolled-back"] as const)(
    "keeps a missing reason unchanged for a %s update with a failed child",
    (status) => {
      const record = run({ status, reason: null });
      const before = renderUpdateRunReport(record).headline;
      const report = renderUpdateRunReport({
        ...record,
        steps: [{ step: "finalize:doctor", status: "failed" }],
      });
      expect(report.headline).toBe(before);
      expect(report.headline).toContain("unknown reason");
    },
  );

  describe("current-main failed-step fallback interactions", () => {
    it("uses the first meaningful failure without changing saved JSON or notice semantics", () => {
      const record = run({
        status: "failed",
        reason: "  ",
        steps: [
          { step: "requested", status: "failed" },
          { step: "staging", status: "completed" },
          { step: "finalize:doctor", status: "failed" },
          { step: "finalize:plugins", status: "failed" },
        ],
      });
      const saved = JSON.stringify(record);
      record.steps.forEach(Object.freeze);
      Object.freeze(record.steps);
      Object.freeze(record);

      const report = renderUpdateRunReport(record);
      expect(report.headline).toBe("⚠️ OpenClaw update failed: finalize:doctor.");
      expect(renderUpdateRunNotice(record, "finished")).toBe(report.markdown);
      expect(JSON.stringify(record)).toBe(saved);
    });

    it.each([
      { reason: "abandoned", reconciled: true },
      { reason: "legacy-driver-expired", reconciled: true },
      { reason: null, reconciled: false },
      { reason: "  ", reconciled: false },
    ])("keeps acknowledgement tied to the saved reason $reason", ({ reason, reconciled }) => {
      const record = run({
        status: "failed",
        reason,
        origin: { doctorHint: "Run openclaw doctor --fix", nextAction: "Run openclaw triage" },
        steps: [
          { step: "requested", status: "failed" },
          { step: "finalize:doctor", status: "failed" },
          { step: "reconcile:acknowledged", status: "completed", endedAtMs: 301 },
        ],
      });
      const saved = JSON.stringify(record);
      const report = renderUpdateRunReport(record);
      expect(report.headline).toBe(
        reconciled
          ? "ℹ️ OpenClaw abandoned update reconciled."
          : "⚠️ OpenClaw update failed: finalize:doctor.",
      );
      expect(report.lines).toContain("Failed: finalize:doctor");
      expect(report.markdown.includes("Run openclaw")).toBe(!reconciled);
      expect(JSON.stringify(record)).toBe(saved);
    });

    it("bounds an inferred phase at a surrogate boundary without changing the record", () => {
      const phase = `${"x".repeat(238)}🦞${"y".repeat(300)}`;
      const record = run({ status: "failed", steps: [{ step: phase, status: "failed" }] });
      const saved = JSON.stringify(record);
      const report = renderUpdateRunReport(record);
      expect(report.headline).toBe(`⚠️ OpenClaw update failed: ${"x".repeat(238)}….`);
      expect(report.headline.length).toBeLessThanOrEqual(500);
      expect(report.markdown.length).toBeLessThanOrEqual(1500);
      expect(Buffer.from(report.markdown).toString("utf8")).toBe(report.markdown);
      expect(JSON.stringify(record)).toBe(saved);
    });

    it.each([
      { status: "succeeded" as const, reason: null },
      { status: "running" as const, reason: null },
      { status: "skipped" as const, reason: "gateway-readiness-unverified" },
      { status: "skipped" as const, reason: "still-starting" },
    ])("keeps the $status headline when a historical child failed", ({ status, reason }) => {
      const record = run({ status, reason, phase: "verifying" });
      const before = renderUpdateRunReport(record).headline;
      const report = renderUpdateRunReport({
        ...record,
        steps: [{ step: "finalize:doctor", status: "failed" }],
      });
      expect(report.headline).toBe(before);
      expect(report.headline).not.toContain("finalize:doctor");
    });
  });
});
