import { describe, expect, it } from "vitest";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const context = { env: {}, stateDir: "/report-test-state" };

function prepareDiagnosticReport(reason: string) {
  return prepareUpdateFailureReport(
    {
      attemptId: "diagnostic-value",
      result: { mode: "npm", status: "error", reason, steps: [], durationMs: 1 },
    },
    context,
  );
}

describe("update report diagnostic command boundary", () => {
  it.each(
    (["check", "code", "pluginId", "affectedKey"] as const).flatMap((field) =>
      [
        "private-host.example",
        "private-host.example:8123",
        "10.20.30.40",
        "mcp.servers.private-host.example",
      ].map((host) => ({
        field,
        host,
      })),
    ),
  )("does not publish endpoint $host supplied as $field", async ({ field, host }) => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "poisoned-identifier",
        result: {
          status: "error",
          mode: "npm",
          durationMs: 0,
          steps: [
            {
              name: "verify",
              command: "",
              cwd: "",
              durationMs: 0,
              exitCode: 1,
              failureFacts: [{ check: "readyz", code: "readyz-unhealthy", [field]: host }],
            },
          ],
        },
      },
      context,
    );
    expect(report.body).not.toContain(host);
    expect(report.body).toContain("Failing check");
  });
  it.each([
    'Permission denied at "/Users/Example Person/private documents/secret.json"',
    "Permission denied at /home/example/private file.json",
    'Permission denied at "C:\\Users\\Example Person\\private\\secret.json"',
    "Permission denied at ~/private/secret.json",
    "Permission denied at \u001b[31m/Users/example/private/secret.json\u001b[0m",
    "Permission denied at file:///Users/example/private/secret.json",
  ])("keeps a failing check while removing private paths: %s", async (message) => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "failure-fact-redaction",
        result: {
          mode: "npm",
          status: "error",
          reason: "doctor-failed",
          durationMs: 1,
          steps: [
            {
              name: "doctor",
              command: "",
              cwd: "",
              durationMs: 1,
              exitCode: 1,
              failureFacts: [
                {
                  check: "core/doctor/gateway-config",
                  code: "EACCES",
                  affectedKey: "mcp.servers",
                  message: `token=synthetic-token-value ${message}\nprivate second line`,
                },
              ],
            },
          ],
        },
      },
      context,
    );
    expect(report.body).toContain("Failing check core/doctor/gateway-config (EACCES)");
    expect(report.body).toContain("Permission denied");
    expect(report.body).toContain("mcp.servers");
    for (const secret of [
      "synthetic-token-value",
      "Example Person",
      "example/",
      "secret.json",
      "private second line",
      "private file",
    ]) {
      expect(report.body).not.toContain(secret);
    }
  });
  it("does not imply rollback when candidate repair stops before activation", async () => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "candidate-repair-refused",
        target: "version 2026.9.4",
        result: {
          mode: "npm",
          status: "error",
          reason: "repair-requires-config-change",
          before: { version: "2026.9.3" },
          after: { version: "2026.9.3" },
          steps: [
            {
              name: "repairing",
              command: "repair staged candidate",
              cwd: "/candidate",
              durationMs: 1,
              exitCode: 1,
            },
          ],
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          durationMs: 1,
        },
      },
      context,
    );

    expect(report.body).toContain("Failed phase: repairing");
    expect(report.body).toContain("After version: 2026.9.3");
    expect(report.body).toContain("Recovery outcome: not verified (runtime-verification-failed)");
    expect(report.body.toLowerCase()).not.toContain("rollback");
  });

  it("records the running Node version in the reviewed report", async () => {
    const report = await prepareDiagnosticReport("node-runtime-preflight");
    expect(report.body).toContain(`- Node version: ${process.versions.node}\n`);
  });

  it.each([
    { service: undefined, outcome: "verified safe to restart" },
    { service: "healthy", outcome: "verified safe to restart" },
    {
      service: "failed",
      outcome:
        "runtime files verified; Gateway restart failed. Run `openclaw gateway status --deep` before restarting manually.",
    },
  ] as const)(
    "reports the observed recovery service outcome: $service",
    async ({ service, outcome }) => {
      const report = await prepareUpdateFailureReport(
        {
          attemptId: "recovery-service-outcome",
          result: {
            mode: "npm",
            status: "error",
            reason: "runtime-verification-failed",
            recovery: { serviceRestartSafe: true, version: "2026.9.4", service },
            steps: [],
            durationMs: 1,
          },
        },
        context,
      );
      expect(report.body).toContain(`- Recovery outcome: ${outcome}\n`);
    },
  );

  it.each([
    'Command failed: python -c "private-customer-text"',
    'ruby -e "private-customer-text"',
    "custom-tool private-customer-text",
    "custom-tool\u00a0private-customer-text",
    "custom-tool;private-customer-text",
    "$(private-customer-text)",
    "`private-customer-text`",
  ])("omits command-shaped diagnostic value %s without an executable-name list", async (value) => {
    const report = await prepareDiagnosticReport(value);
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).toContain("- Reason code: [redacted-command]\n");
  });

  it.each([
    "build",
    "global-install-failed",
    "origin/main@abcdef",
    "openclaw@2026.9.1",
    "linux/arm64",
    "🦞".repeat(5),
  ])("preserves scalar structured fact %s", async (value) => {
    const report = await prepareDiagnosticReport(value);
    expect(report.body).toContain(`- Reason code: ${value}\n`);
  });

  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
    "keeps independent scalar lines around a command with separator %j",
    async (separator) => {
      const value = ["build", "custom-tool private-customer-text", "linux/arm64"].join(separator);
      const report = await prepareDiagnosticReport(value);
      expect(report.body).not.toContain("private-customer-text");
      expect(report.body).toContain(
        `- Reason code: ${["build", "[redacted-command]", "linux/arm64"].join(separator)}\n`,
      );
    },
  );

  it("excludes arbitrary command arguments from the prepared public body", async () => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "unlisted-executable",
        target: 'custom-updater --customer "private-customer-text"',
        result: {
          mode: "npm",
          status: "error",
          reason: 'Command failed: python -c "private-customer-text"',
          before: { version: "custom-tool private-customer-text", sha: "/private-customer-text" },
          after: {
            version: "C:\\private-customer-text",
            sha: "~\\private-customer-text",
            buildId: '"PowerShell.EXE" -EncodedCommand private-customer-text',
          },
          steps: [
            {
              name: 'ruby -e "private-customer-text"',
              command: "never copied",
              cwd: "/private",
              durationMs: 1,
              exitCode: 7,
            },
          ],
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          durationMs: 1,
        },
      },
      context,
    );
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).toContain("exit 7");
    expect(report.body).toContain("Update mode: npm");
    expect(report.body).toContain("Recovery outcome: not verified");
  });

  it.each([
    "version 2026.9.1",
    "version 2026.9.1-beta.1",
    "version 2026.9.1+build.abc",
    "stable channel",
    "extended-stable channel",
    "beta channel",
    "dev channel",
  ])("retains the canonical structured target %s", async (target) => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "structured-target",
        target,
        result: { mode: "npm", status: "error", reason: "build-failed", steps: [], durationMs: 1 },
      },
      context,
    );
    expect(report.body).toContain(`- Update target: ${target}\n`);
  });

  it.each([
    "version private-customer-text",
    "version 2026.9.1 private-customer-text",
    "version 2026.9.1\u00a0private-customer-text",
    "version 2026.9.1;private-customer-text",
    "stable channel private-customer-text",
    "private-customer-text channel",
  ])("does not treat unvalidated target prose as structured facts: %s", async (target) => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "untrusted-target",
        target,
        result: { mode: "npm", status: "error", reason: "build-failed", steps: [], durationMs: 1 },
      },
      context,
    );
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).toContain("- Update target: [redacted-command]\n");
  });

  it("uses the failure code when a phase label is executable text", async () => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "structured-phase",
        result: {
          mode: "npm",
          status: "error",
          reason: "doctor-failed",
          steps: [
            {
              name: "openclaw doctor",
              command: "not copied",
              cwd: "/private",
              durationMs: 1,
              exitCode: 1,
            },
          ],
          durationMs: 1,
        },
      },
      context,
    );
    expect(report.body).toContain("- Failed phase: doctor-failed\n");
    expect(report.body).not.toContain("openclaw doctor");
  });

  it("retains failed phases from the durable run when the handoff result is compact", async () => {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "durable-failure-history",
        result: {
          mode: "git",
          status: "error",
          reason: "state-migrated-no-rollback",
          steps: [],
          durationMs: 1,
        },
        recordedRun: {
          runId: "durable-failure-history",
          steps: [
            { step: "custom-tool private-customer-text", status: "failed" },
            { step: "activating", status: "failed" },
            {
              step: "package rollback",
              status: "failed",
              detail: "Gateway service ownership or manager identity changed",
            },
          ],
        },
      },
      context,
    );

    expect(report.body).toContain("- Failed phase: package-rollback\n");
    expect(report.body).toContain("Failed phase activating: exit unknown");
    expect(report.body).toContain("Failed phase package-rollback: exit unknown");
    expect(report.body).toContain("Failed phase [redacted-command]: exit unknown");
    expect(report.body).not.toContain("private-customer-text");
    expect(report.body).not.toContain("Gateway service ownership");
  });

  it.each([{ earlierFailures: [] }, { earlierFailures: ["activating"] }])(
    "preserves ledger order and measured exits after $earlierFailures",
    async ({ earlierFailures }) => {
      const report = await prepareUpdateFailureReport(
        {
          attemptId: "measured-failure-history",
          result: {
            mode: "git",
            status: "error",
            reason: "verification-failed",
            steps: [
              {
                name: "verifying",
                command: "not copied",
                cwd: "/private",
                durationMs: 1,
                exitCode: 7,
              },
            ],
            durationMs: 1,
          },
          recordedRun: {
            runId: "measured-failure-history",
            steps: [...earlierFailures, "verifying"].map((step) => ({ step, status: "failed" })),
          },
        },
        context,
      );

      expect(report.body).toContain("- Failed phase: verifying\n");
      expect(report.body).toContain("Failed phase verifying: exit 7");
      expect(report.body.match(/Failed phase verifying:/gu)).toHaveLength(1);
      for (const earlier of earlierFailures) {
        expect(report.body.indexOf(`Failed phase ${earlier}: exit unknown`)).toBeGreaterThan(-1);
        expect(report.body.indexOf(`Failed phase ${earlier}: exit unknown`)).toBeLessThan(
          report.body.indexOf("Failed phase verifying: exit 7"),
        );
      }
    },
  );
});
