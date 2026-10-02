import { describe, expect, it } from "vitest";
import type { UpdateRunRecord } from "./update-run-record.js";
import { renderUpdateRunReport } from "./update-run-report.js";

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

describe("capped update run report", () => {
  it("preserves a long saved action when current-health qualification exceeds the suffix budget", () => {
    const prefix = "Managed gateway remains stopped. Keep it stopped. ";
    const tail = "TAIL-MUST-SURVIVE";
    const advice = `${prefix}${"A".repeat(1024 - prefix.length - tail.length)}${tail}`;
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "restart-unhealthy",
        origin: { nextAction: advice },
        verification: { serviceRunning: false, versionMatch: false },
      }),
      { currentHealth: { kind: "responding", version: "2026.9.2" } },
    );

    expect(advice).toHaveLength(1024);
    expect(report.markdown).toContain("Current health: Gateway answered");
    expect(report.markdown).toContain("supersedes saved claims that the Gateway is stopped");
    expect(report.markdown).toContain("Historical recovery advice:");
    expect(report.markdown.endsWith(advice)).toBe(true);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("redistributes unused protected budget from short facts to longer details", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "runtime-verification-failed",
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `Service reconciliation detail: ${"R".repeat(993)}`,
          },
        ],
        verification: { serviceRunning: false },
      }),
      { nextAction: "N".repeat(1024) },
    );
    const warningLine = report.markdown.split("\n").find((line) => line.startsWith("Warning:"));

    expect(report.markdown).toHaveLength(1500);
    expect(warningLine?.length).toBeGreaterThan(300);
  });

  it("preserves runtime-check safety facts when diagnostics exceed the details budget", () => {
    const nextAction = "N".repeat(1024);
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "node-runtime-preflight",
        steps: [
          {
            step: "diagnostic:database snapshot",
            status: "completed",
            detail: `Snapshot diagnostic: ${"D".repeat(1_200)}`,
          },
          { step: "gateway recovery verification", status: "completed", exitCode: 0 },
        ],
        verification: {
          serviceRunning: true,
          runningVersion: "2026.9.7",
          versionMatch: true,
          readyz: true,
          settled: true,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
      }),
      { nextAction },
    );

    expect(report.markdown.split("\n")[1]).toBe(nextAction);
    expect(report.markdown).toContain("Recovery: serving; restart unsafe.");
    expect(report.markdown).toContain("Verification: serving.");
    expect(report.markdown).toContain("… run openclaw update status");
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("keeps the failure explanation and reason under moderate runtime report pressure", () => {
    const prefix = "Managed gateway remains stopped. Keep it stopped. ";
    const advice = `${prefix}${"A".repeat(900 - prefix.length)}`;
    const diagnosticPrefix = "Snapshot diagnostic: ";
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "node-runtime-preflight",
        origin: { nextAction: advice },
        steps: [
          {
            step: "diagnostic:database snapshot",
            status: "completed",
            detail: `${diagnosticPrefix}${"D".repeat(1024 - diagnosticPrefix.length)}`,
          },
        ],
      }),
      { currentHealth: { kind: "responding", version: "2026.9.7" } },
    );

    expect(report.markdown).toContain(
      "⚠️ OpenClaw could not complete the update. A required system check failed.",
    );
    expect(report.markdown).toContain("Reason code: node-runtime-preflight");
    expect(report.markdown).toContain("Health: responding; stop advice stale.");
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("qualifies long saved stop advice during a runtime-check failure", () => {
    const prefix = "Managed gateway remains stopped. Keep it stopped. ";
    const advice = `${prefix}${"A".repeat(1024 - prefix.length)}`;
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "node-runtime-preflight",
        origin: { nextAction: advice },
      }),
      { currentHealth: { kind: "responding", version: "2026.9.2" } },
    );

    expect(report.markdown).toContain("Historical recovery advice:");
    expect(report.markdown).toContain("Current health: Gateway answered");
    expect(report.markdown).toContain("supersedes saved claims that the Gateway is stopped");
    expect(report.lines.join("\n").match(/Current health: Gateway answered/gu)).toHaveLength(1);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("keeps compact health qualification and the advice tail with overflowing runtime diagnostics", () => {
    const prefix = "Managed gateway remains stopped. Keep it stopped. ";
    const tail = "TAIL-MUST-SURVIVE";
    const advice = `${prefix}${"A".repeat(1024 - prefix.length - tail.length)}${tail}`;
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "node-runtime-preflight",
        origin: { nextAction: advice },
        steps: [
          {
            step: "diagnostic:database snapshot",
            status: "completed",
            detail: `Snapshot diagnostic: ${"D".repeat(1_800)}`,
          },
        ],
      }),
      { currentHealth: { kind: "responding", version: "2026.9.2" } },
    );

    expect(report.markdown).toContain("Health: responding; stop advice stale.");
    expect(report.markdown).toContain("… run openclaw update status");
    expect(report.markdown).toContain(tail);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("preserves a fresh current-health observation without saved advice", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "runtime-verification-failed",
        steps: [
          {
            step: "diagnostic:database snapshot",
            status: "completed",
            detail: `Snapshot diagnostic: ${"D".repeat(1_800)}`,
          },
        ],
        verification: { serviceRunning: true, readyz: true },
      }),
      { currentHealth: { kind: "responding", version: "2026.9.2" } },
    );

    expect(report.lines).toContain(
      "Current health: Gateway answered on the recorded port (2026.9.2).",
    );
    expect(report.markdown).toContain(
      "Current health: Gateway answered on the recorded port (2026.9.2).",
    );
    expect(report.markdown).toContain("… run openclaw update status");
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("preserves every protected fact beside a maximum systemd restart command", () => {
    const unit = `openclaw-${"x".repeat(255 - "openclaw-.service".length)}.service`;
    const restartCommand = `sudo systemctl restart ${unit}`;
    const advicePrefix = "Managed gateway remains stopped. Keep it stopped. ";
    const advice = `${advicePrefix}${"A".repeat(1024 - advicePrefix.length)}`;
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "runtime-verification-failed",
        origin: { nextAction: advice },
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `System-scope Gateway service ${unit} requires an operator restart. After the update, run: ${restartCommand}`,
          },
          { step: "gateway recovery verification", status: "completed", exitCode: 0 },
        ],
        verification: {
          serviceRunning: true,
          runningVersion: "2026.9.7",
          versionMatch: true,
          readyz: true,
          settled: true,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
      }),
      { currentHealth: { kind: "responding", version: "2026.9.7" } },
    );
    const lines = report.markdown.split("\n");

    expect(lines).toContain("⚠️ Failed.");
    expect(lines.some((line) => line.startsWith("Restart:") && line.includes(restartCommand))).toBe(
      true,
    );
    expect(lines).toContain("Recovery: serving; restart unsafe.");
    expect(lines).toContain("Verification: serving.");
    expect(lines).toContain("Health: responding; stop advice stale.");
    expect(report.markdown).toContain("Historical recovery advice:");
    expect(report.markdown.endsWith(advice)).toBe(true);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("keeps fresh health explicit beside maximum runtime recovery inputs", () => {
    const unit = `openclaw-${"x".repeat(255 - "openclaw-.service".length)}.service`;
    const restartCommand = `sudo systemctl restart ${unit}`;
    const advicePrefix = "Managed gateway remains stopped. Keep it stopped. ";
    const tail = "TAIL-MUST-SURVIVE";
    const advice = `${advicePrefix}${"A".repeat(1024 - advicePrefix.length - tail.length)}${tail}`;
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "node-runtime-preflight",
        origin: { nextAction: advice },
        steps: [
          {
            step: "diagnostic:database snapshot",
            status: "completed",
            detail: `Snapshot diagnostic: ${"D".repeat(1_800)}`,
          },
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `System-scope Gateway service ${unit} requires an operator restart. After the update, run: ${restartCommand}`,
          },
          { step: "gateway recovery verification", status: "completed", exitCode: 0 },
        ],
        verification: {
          serviceRunning: true,
          runningVersion: "2026.9.7",
          versionMatch: true,
          readyz: true,
          settled: true,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
      }),
      { currentHealth: { kind: "responding", version: "2026.9.7" } },
    );
    const lines = report.markdown.split("\n");

    expect(lines.some((line) => line.startsWith("Restart:") && line.includes(restartCommand))).toBe(
      true,
    );
    expect(lines).toContain("Recovery: serving; restart unsafe.");
    expect(lines).toContain("Verification: serving.");
    expect(lines).toContain("Health: responding; stop advice stale.");
    expect(report.markdown).toContain("… run openclaw update status");
    expect(report.markdown).toContain(tail);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("bounds a colonless success headline without dropping the outcome or verification", () => {
    const nextAction = "N".repeat(1024);
    const report = renderUpdateRunReport(
      run({
        before: { version: "B".repeat(240) },
        after: { version: "A".repeat(240) },
        verification: { serviceRunning: true, versionMatch: true },
      }),
      { nextAction },
    );
    const lines = report.markdown.split("\n");

    expect(lines[0]).toBe("✅ Updated.");
    expect(lines.some((line) => line.startsWith("Verification:"))).toBe(true);
    expect(lines).toContain("… run openclaw update status");
    expect(report.markdown.endsWith(nextAction)).toBe(true);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
  });

  it("lets a failed recovery observation override stale passing verification flags", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "runtime-verification-failed",
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `Service reconciliation detail: ${"R".repeat(993)}`,
          },
          {
            step: "gateway recovery verification",
            status: "failed",
            exitCode: 1,
            failureFacts: [{ check: "readiness", code: "gateway-probe-failed" }],
          },
        ],
        verification: {
          runningVersion: "2026.9.7",
          versionMatch: true,
          readyz: true,
          settled: true,
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.7" },
        },
      }),
      { nextAction: "N".repeat(1024) },
    );

    expect(report.lines).toContain(
      "Recorded recovery: recovery probe failed (gateway-probe-failed).",
    );
    expect(report.markdown).toContain("Recovery: probe failed.");
    expect(report.markdown).not.toContain("Recovery: serving verified.");
  });

  it("keeps a failed process state ahead of plugin errors in compact verification", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "runtime-verification-failed",
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `Service reconciliation detail: ${"R".repeat(993)}`,
          },
        ],
        verification: { serviceRunning: false, pluginErrors: ["plugin failed"] },
      }),
      { nextAction: "N".repeat(1024) },
    );

    expect(report.lines).toContain(
      "Recorded verification: service stopped; 1 plugin activation error(s).",
    );
    expect(report.markdown).toContain("Verification: stopped; plugin errors.");
  });

  it("keeps a nonzero recovery observation without failure facts pending", () => {
    const report = renderUpdateRunReport(
      run({
        status: "failed",
        reason: "runtime-verification-failed",
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `Service reconciliation detail: ${"R".repeat(993)}`,
          },
          { step: "gateway recovery verification", status: "failed", exitCode: 1 },
        ],
      }),
      { nextAction: "N".repeat(1024) },
    );

    expect(report.lines).toContain(
      "Recorded recovery: Gateway readiness is pending; recovery probe completed without verified readiness.",
    );
    expect(report.markdown).toContain("Recovery: readiness pending.");
    expect(report.markdown).not.toContain("Recovery: not serving.");
  });

  it.each(["still-starting", "gateway-readiness-unverified"])(
    "keeps the installed outcome when compacting %s",
    (reason) => {
      const report = renderUpdateRunReport(
        run({
          status: "skipped",
          reason,
          steps: [
            {
              step: "warning:managed-service-reconciliation",
              status: "completed",
              detail: `Service reconciliation detail: ${"R".repeat(993)}`,
            },
          ],
          verification: { readyz: false },
        }),
        { nextAction: "N".repeat(1024) },
      );

      expect(report.markdown.split("\n")[0]).toBe("ℹ️ Installed; readiness unverified.");
      expect(report.markdown).not.toContain("ℹ️ Update skipped.");
    },
  );

  it("does not turn a running process into verified serving when readiness is unknown", () => {
    const report = renderUpdateRunReport(
      run({
        status: "skipped",
        reason: "gateway-readiness-unverified",
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `Service reconciliation detail: ${"R".repeat(993)}`,
          },
          { step: "gateway recovery verification", status: "completed", exitCode: 0 },
        ],
        verification: { serviceRunning: true, versionMatch: true },
      }),
      { nextAction: "N".repeat(1024) },
    );

    expect(report.markdown).toContain("Recovery: readiness pending.");
    expect(report.markdown).toContain("Verification: service running.");
    expect(report.markdown).not.toContain("Verification: serving.");
  });

  it.each([
    [{ booted: true }, "Verification: booted."],
    [{ channelsReady: true }, "Verification: channels ready."],
    [{ booted: true, channelsReady: true }, "Verification: booted; channels ready."],
  ] as const)("names positive-only compact verification facts %#", (verification, expected) => {
    const report = renderUpdateRunReport(
      run({
        steps: [
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `Service reconciliation detail: ${"R".repeat(993)}`,
          },
        ],
        verification,
      }),
      { nextAction: "N".repeat(1024) },
    );

    expect(report.markdown).toContain(expected);
    expect(report.markdown).not.toContain("Verification: checks recorded.");
  });

  it("omits complete lines instead of cutting the final report body mid-line", () => {
    const nextAction = "N".repeat(429);
    const report = renderUpdateRunReport(
      run({
        steps: [
          {
            step: "diagnostic:database snapshot",
            status: "completed",
            detail: `Snapshot evidence: ${"s".repeat(480)}`,
          },
          {
            step: "diagnostic:database migration writes",
            status: "completed",
            detail: `Migration evidence: ${"m".repeat(480)}`,
          },
          {
            step: "warning:managed-service-reconciliation",
            status: "completed",
            detail: `System-scope Gateway service: ${"r".repeat(480)}`,
          },
          {
            step: "warning:doctor",
            status: "completed",
            detail: `Doctor warning: ${"d".repeat(480)}`,
          },
        ],
      }),
      { nextAction },
    );

    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    expect(report.markdown.endsWith(`\n${nextAction}`)).toBe(true);
    expect(report.lines.join("\n").length + nextAction.length + 1).toBeGreaterThan(1500);
    expect(report.markdown.split("\n")).toContain("… run openclaw update status");
    const completeLines = new Set([
      report.headline,
      "✅ Updated.",
      ...report.lines,
      "… run openclaw update status",
      "Warning: 1 more warning omitted; run openclaw update status for the full report.",
    ]);
    const compactProtectedLines = report.markdown
      .split("\n")
      .filter((line) => !completeLines.has(line));
    expect(compactProtectedLines).toHaveLength(1);
    expect(compactProtectedLines[0]).toMatch(/^Warning: System-scope Gateway service: .+$/u);
    expect(report.markdown.split("\n")).not.toContain("W…");
  });
});
