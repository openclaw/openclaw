import { afterEach, describe, expect, it, vi } from "vitest";
import { isReportableUpdateRun } from "../shared/update-outcome.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import * as reportHealth from "./update-run-report-health.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
  updateRunReportInputFromSentinel,
} from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

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

function failureReport(record: UpdateRunRecord, result: Partial<UpdateRunResult> = {}) {
  return prepareUpdateFailureReport(
    {
      attemptId: record.runId,
      recordedRun: record,
      result: { status: "error", mode: "npm", steps: [], durationMs: 0, ...result },
    },
    { stateDir: "/fixture/state", env: {} },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("update run report", () => {
  it.each([
    {
      reason: "preflight-node-runtime-incompatible",
      detail: "Node 24.15.0; requires engines.node >=24.16.0",
    },
    { reason: "node-runtime-preflight", detail: "Runtime capability probe failed" },
  ])("separates the runtime check failure from its $detail diagnostics", ({ reason, detail }) => {
    const record = run({
      status: "failed",
      reason,
      steps: [
        { step: "staging", status: "completed" },
        {
          step: "preflight-node-runtime",
          status: "failed",
          detail,
          failureFacts: [{ check: "node-runtime", code: reason, affectedKey: "engines.node" }],
        },
      ],
    });
    const saved = structuredClone(record);
    const nextAction = "Run `openclaw --profile work triage` to repair this installation.";
    const report = renderUpdateRunReport(record, { nextAction });

    expect(report.headline).toBe(
      "⚠️ OpenClaw could not complete the update. A required system check failed.",
    );
    expect(report.lines.slice(0, 4)).toEqual([
      nextAction,
      "",
      "Details:",
      `Reason code: ${reason}`,
    ]);
    expect(report.markdown).toContain(`${report.headline}\n${nextAction}\n\nDetails:`);
    expect(report.markdown).toContain(`Failed: preflight-node-runtime — ${detail}`);
    expect(report.markdown).toContain(`Failing check node-runtime (${reason}); key engines.node`);
    expect(report.markdown).toContain("Phases: staging");
    expect(record).toEqual(saved);
  });

  it.each([true, false])("keeps runtime guidance within the chat budget (saved=%s)", (saved) => {
    const action = `Keep the candidate installed and do not roll back code alone. ${"🦞".repeat(600)}`;
    const record = run({
      status: "failed",
      reason: "node-runtime-preflight",
      origin: saved ? { nextAction: action } : {},
      steps: [{ step: "preflight-node-runtime", status: "failed", detail: "detail ".repeat(300) }],
    });
    const report = renderUpdateRunReport(record, saved ? {} : { nextAction: action });
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    expect(Buffer.from(report.markdown).toString("utf8")).toBe(report.markdown);
    expect(report.markdown).toContain(
      "Keep the candidate installed and do not roll back code alone.",
    );
    expect(report.markdown).toContain("Reason code: node-runtime-preflight");
    expect(report.lines.join("\n")).toContain(action);
    expect(report.markdown.includes("Historical recovery advice:")).toBe(saved);
  });

  it.each([
    { advice: true, responding: true },
    { advice: false, responding: false },
  ])(
    "separates recorded recovery from current observations (advice=$advice, responding=$responding)",
    ({ advice, responding }) => {
      const record = run({
        status: "failed",
        reason: "node-runtime-preflight",
        origin: advice
          ? {
              nextAction:
                "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds. Keep the candidate installed and do not roll back code alone.",
            }
          : {},
        steps: [{ step: "gateway recovery verification", status: "completed", exitCode: 0 }],
        verification: {
          serviceRunning: true,
          runningVersion: "2026.9.1",
          versionMatch: true,
          readyz: true,
          channelsReady: false,
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.1" },
        },
      });
      const saved = structuredClone(record);
      const currentHealth = responding
        ? { kind: "responding" as const, version: "2026.9.2" }
        : { kind: "unavailable" as const };
      const report = renderUpdateRunReport(record, { currentHealth });
      expect(report.markdown).toContain("Recorded recovery: verified serving 2026.9.1.");
      expect(report.markdown).toContain(
        "Recorded verification: service running (2026.9.1); version verified; channels not ready; HTTP ready.",
      );
      expect(report.markdown).toContain(
        responding
          ? "Current health: Gateway answered on the recorded port (2026.9.2)."
          : "Current health unavailable; saved verification describes the update attempt only.",
      );
      expect(report.markdown.includes("Historical recovery advice:")).toBe(advice);
      if (advice) {
        expect(report.lines).not.toContain(record.origin.nextAction);
        expect(report.markdown).toContain("supersedes saved claims that the Gateway is stopped");
        expect(report.markdown.endsWith(record.origin.nextAction!)).toBe(false);
        expect(report.markdown).toContain(
          "Keep the candidate installed and do not roll back code alone.",
        );
      }
      expect(report.headline).not.toContain("gateway is running");
      expect(report.markdown).not.toContain("chat");
      expect(record).toEqual(saved);
    },
  );

  it.each([
    { reason: "state-migration-started", raw: false },
    { reason: "runtime-verification-failed", raw: true },
  ] as const)(
    "reports serving health with its $reason constraint (raw=$raw)",
    async ({ reason, raw }) => {
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
      const report = await failureReport(
        record,
        raw
          ? {
              verification: {
                runningVersion: "2026.9.5",
                versionMatch: true,
                readyz: true,
                settled: true,
              },
              recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
              steps: [
                {
                  name: "gateway recovery verification",
                  command: "verify",
                  cwd: "/fixture",
                  durationMs: 0,
                  exitCode: 0,
                },
              ],
            }
          : {},
      );
      expect(report.body).toContain(`Recovery outcome: ${expected}`);
      expect(record.verification.recovery?.serviceRestartSafe).toBe(false);
    },
  );

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

  it.each<{
    reason: string | null;
    acknowledgement: "completed" | "in_progress" | "failed";
    reconciled: boolean;
  }>([
    { reason: "abandoned", acknowledgement: "completed", reconciled: true },
    { reason: "legacy-driver-expired", acknowledgement: "completed", reconciled: true },
    { reason: null, acknowledgement: "completed", reconciled: false },
    { reason: "  ", acknowledgement: "completed", reconciled: false },
    { reason: "abandoned", acknowledgement: "in_progress", reconciled: false },
    { reason: "abandoned", acknowledgement: "failed", reconciled: false },
  ])(
    "requires completed acknowledgement of a saved abandonment ($reason, $acknowledgement)",
    ({ reason, acknowledgement, reconciled }) => {
      const record = run({
        status: "failed",
        reason,
        origin: { doctorHint: "Run openclaw doctor --fix", nextAction: "Run openclaw triage" },
        steps: [
          { step: "requested", status: "failed" },
          { step: "finalize:doctor", status: "failed" },
          { step: "reconcile:abandoned", status: "failed", detail: "inactive-driver-dead" },
          { step: "reconcile:acknowledged", status: acknowledgement, endedAtMs: 301 },
        ],
      });
      const saved = structuredClone(record);
      const report = renderUpdateRunReport(record);
      expect(report.headline).toBe(
        reconciled
          ? "ℹ️ OpenClaw abandoned update reconciled."
          : `⚠️ OpenClaw update failed: ${reason?.trim() || "finalize:doctor"}.`,
      );
      expect(report.lines).toContain("Failed: finalize:doctor");
      expect(report.lines).toContain("Failed: reconcile:abandoned — inactive-driver-dead");
      expect(report.markdown.includes("Run openclaw")).toBe(!reconciled);
      if (reconciled) {
        expect(report.markdown).not.toContain("to retry");
      } else {
        expect(report.markdown).toContain("Run openclaw triage");
      }
      expect(record).toEqual(saved);
    },
  );

  it.each([
    { version: "private-customer-build", observed: false },
    { version: "2026.9.4-private-customer", observed: true },
  ])(
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
      const report = await failureReport(record);
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

  it.each<{
    verification: UpdateRunRecord["verification"];
    expected: string;
    publicReport?: boolean;
  }>([
    {
      verification: { runningVersion: "2026.9.1", versionMatch: false },
      expected: "version mismatch",
    },
    {
      verification: {
        runningVersion: "2026.9.2",
        runningBuildId: "older-build",
        versionMatch: false,
      },
      expected: "build mismatch",
    },
    {
      verification: { runningVersion: "2026.9.2", versionMatch: false },
      expected: "service identity unavailable",
    },
    {
      verification: { serviceRunning: true, versionMatch: false },
      expected: "service running; service identity unavailable",
      publicReport: true,
    },
  ])(
    "reports only observed identity disagreement ($expected)",
    async ({ verification, expected, publicReport }) => {
      const record = run({
        status: "failed",
        reason: "restart-unhealthy",
        after: { version: "2026.9.2", buildId: "candidate-build" },
        verification,
      });
      const report = renderUpdateRunReport(record);
      expect(report.lines).toContain(`Recorded verification: ${expected}.`);
      if (publicReport) {
        const failure = await failureReport(record);
        for (const text of [report.markdown, failure.body]) {
          expect(text).toContain("identity unavailable");
          expect(text).not.toContain("version mismatch");
        }
      }
    },
  );

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
    {
      label: "version upgrade without a recorded previous commit",
      before: { version: "2026.9.6" },
      after: { version: "2026.9.7", sha: "2dd93a290b748686160b4a478b7ee003cc0f9f24" },
      expected: "2026.9.7 (2dd93a29) (from 2026.9.6)",
    },
    {
      label: "version upgrade with both commits",
      before: { version: "2026.9.6", sha: "1111111111111111111111111111111111111111" },
      after: { version: "2026.9.7", sha: "9f3c21a0000000000000000000000000000000aa" },
      expected: "2026.9.7 (9f3c21a0) (from 2026.9.6 (11111111))",
    },
    {
      label: "commit change within the same version",
      before: { version: "2026.8.1", sha: "1111111111111111111111111111111111111111" },
      after: { version: "2026.8.1", sha: "9f3c21a0000000000000000000000000000000aa" },
      expected: "2026.8.1 (9f3c21a0) (from 2026.8.1 (11111111))",
    },
    {
      label: "legacy record with only commits",
      before: { sha: "1111111111111111111111111111111111111111" },
      after: { sha: "9f3c21a0000000000000000000000000000000aa" },
      expected: "9f3c21a0 (from 11111111)",
    },
  ])("identifies the installed version and revision for $label", ({ before, after, expected }) => {
    const report = renderUpdateRunReport(run({ before, after }));
    expect(report.headline).toBe(`✅ OpenClaw updated to ${expected}.`);
    expect(report.markdown).toContain(report.headline);
    expect(report.lines).toContain("Phases: staging (300ms)");
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

  const originAction = "Run `openclaw --profile work triage` to repair this installation.";
  const selectedAction = "Run `openclaw --profile team triage` to repair this installation.";
  it.each<{
    label: string;
    patch: Partial<UpdateRunRecord>;
    options?: Parameters<typeof renderUpdateRunReport>[1];
    contains: string[];
    excludes?: string[];
    historical?: boolean;
    selected?: boolean;
  }>([
    {
      label: "unmanaged runtime",
      patch: { reason: "node-runtime-preflight" },
      contains: ["Reason code: node-runtime-preflight", "Run openclaw triage"],
    },
    {
      label: "managed runtime",
      patch: {
        reason: "node-runtime-preflight",
        target: { kind: "package", installationMethod: "ocm" },
      },
      contains: ["Reason code: node-runtime-preflight"],
      excludes: ["Run openclaw triage"],
    },
    {
      label: "storage refusal",
      patch: { reason: "preflight-insufficient-space" },
      contains: ["Free space on the preflight staging"],
    },
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
    ].map((patch) => ({
      label: `migration rollback refusal without saved guidance (${patch.reason})`,
      patch,
      contains: [
        "State may have changed during migration, so rolling back code alone is unsafe.",
        "Keep the new installation and backups",
        "openclaw update status",
        "openclaw doctor",
      ],
      excludes: ["Run openclaw triage"],
    })),
    ...(
      [
        ["requester-revoked", "A current command owner must start a new update"],
        ["repair-requires-config-change", "run openclaw doctor --fix under your own authority"],
      ] as const
    ).map(([reason, guidance]) => ({
      label: reason,
      patch: {
        reason: "doctor-failed",
        repair: [{ attempt: 1, status: "failed" as const, startedAtMs: 1, reason }],
      },
      contains: [reason, guidance],
    })),
    ...[null, "requester-revoked", "state-migrated-no-rollback"].map((reason) => ({
      label: `saved profile after ${reason}`,
      patch: { reason, origin: { nextAction: originAction } },
      historical: true,
      contains: [
        "Historical recovery advice:",
        originAction,
        ...(reason === "requester-revoked"
          ? ["Further recovery requires a current command owner."]
          : []),
      ],
      excludes: [
        "Run openclaw triage",
        "run openclaw doctor --fix",
        "operator can run openclaw triage locally",
        "State may have changed during migration",
      ],
    })),
    {
      label: "selected profile after config refusal",
      patch: { reason: "repair-requires-config-change", origin: { nextAction: originAction } },
      options: { nextAction: selectedAction },
      selected: true,
      contains: ["Doctor could not promote config changes."],
      excludes: [
        originAction,
        "Run openclaw triage",
        "run openclaw doctor --fix",
        "operator can run openclaw triage locally",
      ],
    },
  ])(
    "preserves recovery action ownership: $label",
    ({ patch, options, contains, excludes = [], historical, selected }) => {
      const report = renderUpdateRunReport(run({ status: "failed", ...patch }), options);
      for (const text of contains) {
        expect(report.markdown).toContain(text);
      }
      for (const text of excludes) {
        expect(report.markdown).not.toContain(text);
      }
      if (historical) {
        expect(report.lines).not.toContain(originAction);
      }
      if (selected) {
        expect(report.lines.at(-1)).toBe(selectedAction);
        expect(report.markdown.endsWith(selectedAction)).toBe(true);
      }
    },
  );

  it("keeps advisory steps out of failures and retains multiline diagnostics", () => {
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
            failureFacts: [
              { check: "build", code: "build-failed", message: "last error diagnostic" },
            ],
          },
        ],
      }),
    );
    expect(report.lines.filter((line) => line.startsWith("Failed:"))).toEqual([
      "Failed: build — timeout; last build diagnostic; last error diagnostic",
    ]);
  });

  it.each([
    { message: "Failed", detail: "Permission denied", repeated: false },
    { message: "Permission denied", detail: "Permission denied", repeated: true },
    {
      message: "Permission denied",
      detail: `${"x".repeat(300)} Permission denied`,
      repeated: false,
    },
  ])(
    "keeps facts unless their complete message is visible in the detail ($message, $repeated)",
    ({ message, detail, repeated }) => {
      const report = renderUpdateRunReport(
        run({
          status: "failed",
          steps: [
            {
              step: "package-swap",
              status: "failed",
              detail,
              failureFacts: [{ check: "package-swap", code: "swap-failed", message }],
            },
          ],
        }),
      );
      expect(report.lines).toContain(
        `Failing check package-swap (swap-failed)${repeated ? "" : `: ${message}`}`,
      );
    },
  );

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
    expect(legacy.markdown).toContain("Failed: build");
    expect(legacy.markdown).not.toContain("private legacy");
  });

  it.each<{
    reason: string | null;
    failedSteps: string[];
    expected: string;
  }>([
    {
      reason: " saved-doctor-error ",
      failedSteps: ["finalize:doctor"],
      expected: "saved-doctor-error",
    },
    { reason: null, failedSteps: [], expected: "unknown reason" },
    { reason: null, failedSteps: ["requested"], expected: "unknown reason" },
    { reason: null, failedSteps: ["requested", "finalize:doctor"], expected: "finalize:doctor" },
    {
      reason: "  ",
      failedSteps: ["requested", "finalize:doctor", "finalize:plugins"],
      expected: "finalize:doctor",
    },
    {
      reason: null,
      failedSteps: [`${"x".repeat(238)}🦞${"y".repeat(300)}`],
      expected: `${"x".repeat(238)}…`,
    },
  ])("selects and bounds the failure reason: $expected", ({ reason, failedSteps, expected }) => {
    const record = run({
      status: "failed",
      reason,
      steps: [
        { step: "staging", status: "completed" },
        ...failedSteps.map((step) => ({ step, status: "failed" as const })),
      ],
    });
    const saved = JSON.stringify(record);
    record.steps.forEach(Object.freeze);
    Object.freeze(record.steps);
    Object.freeze(record);
    const report = renderUpdateRunReport(record);
    expect(report.headline).toBe(`⚠️ OpenClaw update failed: ${expected}.`);
    expect(report.headline.length).toBeLessThanOrEqual(500);
    expect(report.markdown.length).toBeLessThanOrEqual(1500);
    expect(Buffer.from(report.markdown).toString("utf8")).toBe(report.markdown);
    expect(JSON.stringify(record)).toBe(saved);
  });

  it.each<Pick<UpdateRunRecord, "status" | "reason"> & { headline: string }>([
    {
      status: "succeeded",
      reason: null,
      headline: "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).",
    },
    { status: "running", reason: null, headline: "⬆️ OpenClaw update in progress: verifying." },
    { status: "skipped", reason: null, headline: "ℹ️ OpenClaw update skipped: unknown reason." },
    {
      status: "rolled-back",
      reason: null,
      headline: "↩️ OpenClaw update rolled back to 2026.9.2: unknown reason.",
    },
    {
      status: "skipped",
      reason: "gateway-readiness-unverified",
      headline:
        "ℹ️ OpenClaw 2026.9.2 installed; Gateway readiness unverified; recovery backups retained.",
    },
    {
      status: "skipped",
      reason: "still-starting",
      headline:
        "ℹ️ OpenClaw 2026.9.2 installed; Gateway still starting; readiness unverified; recovery backups retained.",
    },
  ])(
    "keeps the $status headline when a historical child failed ($reason)",
    ({ status, reason, headline }) => {
      const record = run({ status, reason, phase: "verifying" });
      expect(renderUpdateRunReport(record).headline).toBe(headline);
      const report = renderUpdateRunReport({
        ...record,
        steps: [{ step: "finalize:doctor", status: "failed" }],
      });
      expect(report.headline).toBe(headline);
      expect(report.headline).not.toContain("finalize:doctor");
    },
  );
});
