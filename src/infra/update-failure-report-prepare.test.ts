import { expect, it } from "vitest";
import { createUpdateFailureFact, type UpdateFailureFact } from "./update-failure-facts.js";
import { preparePublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";
import {
  prepareUpdateFailureReport,
  type UpdateFailureReportInput,
} from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

await preparePublicUpdateFailureIdentifiers();
const context = { env: {}, stateDir: "/report-test-state" };
const attemptId = "report-test";
function step(name: string, fields: Partial<UpdateStepResult> = {}): UpdateStepResult {
  return { name, command: "", cwd: "", durationMs: 1, exitCode: 1, ...fields };
}
function report(
  result: Partial<UpdateRunResult> = {},
  input: Omit<Partial<UpdateFailureReportInput>, "result"> = {},
  redaction = context,
) {
  return prepareUpdateFailureReport(
    {
      attemptId,
      result: { mode: "npm", status: "error", steps: [], durationMs: 1, ...result },
      ...input,
    },
    redaction,
  );
}
function expectText(body: string, includes: readonly string[], excludes: readonly string[] = []) {
  for (const text of includes) {
    expect(body).toContain(text);
  }
  for (const text of excludes) {
    expect(body).not.toContain(text);
  }
}

type Diagnostic = {
  name: string;
  fact?: UpdateFailureFact;
  phase?: string;
  reason?: string;
  exitCode?: number | null;
  includes: string[];
  excludes?: string[];
  title?: string;
};
const diagnostics: Diagnostic[] = [
  {
    name: "managed handoff filesystem identities",
    phase: "requested",
    reason: "managed-service-handoff-failed",
    fact: {
      check: "managed-service",
      code: "managed-service-handoff-failed",
      message:
        "managed handoff lease database identity changed at /home/Private Operator/tmp/managed-update-handoffs.sqlite: " +
        "path (recorded /Users/Private Operator/tmp/managed-update-handoffs.sqlite; current /home/Private Operator/tmp/managed-update-handoffs.sqlite); " +
        "file identity (recorded 2096:3530466; current 2096:3530467). Run openclaw update repair.",
    },
    includes: ["managed-service-handoff-failed"],
    excludes: ["Private Operator", "/home/", "/Users/"],
  },
  ...["GLIBC_2.33", "GLIBC_2.2.5", "GLIBC_2.33-private", "GLIBC_PRIVATE"].map((version) => ({
    name: `snapshot loader ${version}`,
    phase: "candidate snapshot",
    reason: "runtime-verification-failed",
    fact: createUpdateFailureFact({
      check: "snapshot",
      code: "candidate-snapshot-failed",
      message:
        "Update state snapshot failed (exit): native no-replace move is unavailable | helper-unavailable\n" +
        `Caused by: /lib/x86_64-linux-gnu/libc.so.6: version \`${version}' not found (required by /home/private-user/private-prefix/fs-safe-native.node) | ERR_DLOPEN_FAILED\n` +
        "private-loader-text token=synthetic-private-token",
    }),
    includes: version === "GLIBC_2.33" || version === "GLIBC_2.2.5" ? [`${version} not found`] : [],
    excludes: [
      "private-user",
      "private-prefix",
      "private-loader-text",
      "synthetic-private-token",
      "/lib/",
      ...(version.endsWith("private") || version === "GLIBC_PRIVATE" ? ["GLIBC_"] : []),
    ],
  })),
  ...[false, true].map((candidate) => ({
    name: `${candidate ? "candidate" : "installed"} config admission`,
    phase: "invalid-config",
    reason: "invalid-config",
    fact: {
      check: candidate ? "candidate-admission" : "invalid-config",
      code: "invalid-config",
      ...(candidate
        ? {
            message:
              "Update refused: configuration is invalid.\n- gateway.port: Invalid configuration field\n- models.providers.private-tenant.apiKey: Invalid configuration field\nprivate rejected value",
          }
        : { affectedKey: "gateway.port", message: "Invalid configuration field" }),
    },
    includes: [
      "gateway.*",
      "Invalid configuration field",
      ...(candidate ? ["models.providers.*"] : []),
    ],
    excludes: ["[redacted-diagnostic]", "private-tenant", "private rejected value"],
  })),
  ...["", " private-customer-text"].map((suffix) => ({
    name: `closed handoff diagnostic ${JSON.stringify(suffix)}`,
    phase: "requested",
    exitCode: null,
    reason: "managed-service-handoff-failed",
    fact: {
      check: "managed-service",
      code: "managed-service-handoff-failed",
      message: `managed update ownership transfer failed${suffix}`,
    },
    includes: suffix ? [] : ["managed update ownership transfer failed"],
    excludes: [
      "private-customer-text",
      ...(suffix ? ["managed update ownership transfer failed"] : []),
    ],
  })),
  ...["startupz", "readyz"].map((check) => ({
    name: `${check} readiness probe`,
    phase: "candidate gateway canary",
    fact: {
      check,
      code: "candidate-readiness-probe-failed",
      message: "Readiness probe failed: HTTP 502. Check the configured proxy.",
    },
    includes: [`Failing check ${check} (candidate-readiness-probe-failed)`],
  })),
  ...(
    [
      ["check", "private-host.example"],
      ["code", "private-host.example:8123"],
      ["pluginId", "10.20.30.40"],
      ["affectedKey", "mcp.servers.private-host.example"],
      ["errorName", "PrivateTenantError"],
    ] as const
  ).map(([field, host]) => ({
    name: `private ${field}`,
    fact: {
      check: "readyz",
      code: field === "errorName" ? "private-code" : "readyz-unhealthy",
      [field]: host,
    },
    includes: ["Failing check"],
    excludes: [host],
  })),
  ...[
    'Permission denied at "/Users/Example Person/private documents/secret.json"',
    "Permission denied at /home/example/private file.json",
    'Permission denied at "C:\\Users\\Example Person\\private\\secret.json"',
    "Permission denied at ~/private/secret.json",
    "Permission denied at \u001b[31m/Users/example/private/secret.json\u001b[0m",
    "Permission denied at file:///Users/example/private/secret.json",
  ].map((message) => ({
    name: message,
    phase: "doctor",
    reason: "doctor-failed",
    fact: {
      check: "core/doctor/gateway-config",
      code: "EACCES",
      affectedKey: "mcp.servers",
      message: `token=synthetic-token-value ${message}\nprivate second line`,
    },
    includes: [
      "Failing check core/doctor/gateway-config (EACCES)",
      "Permission denied",
      "mcp.servers",
    ],
    excludes: [
      "synthetic-token-value",
      "Example Person",
      "example/",
      "secret.json",
      "private second line",
      "private file",
    ],
  })),
  ...(
    [
      ["openclaw doctor", "package-doctor"],
      ["candidate doctor lint", "candidate-doctor-lint"],
      ["Checking update health cleanup", "candidate-doctor-lint-cleanup"],
      ["candidate snapshot", "candidate-state-snapshot"],
      ["post-install verification", "post-install-verify"],
      ["gateway recovery verification", "gateway-recovery-verification"],
      ["finalize:targetConfigConvergence", "finalize-target-config-convergence"],
      ["git checkout refs/private/tenant", "git-checkout"],
      [
        "preflight deps install (ignore scripts) (abcdef01)",
        "preflight-deps-install-ignore-scripts",
      ],
    ] as const
  ).map(([name, id]) => ({
    name: `public phase ${name}`,
    phase: name,
    reason: "doctor-failed",
    fact: name.startsWith("git checkout ") ? { check: name, code: "command-failed" } : undefined,
    includes: [`- Failed phase: ${id}\n`, "- Reason code: doctor-failed\n"],
    excludes: [name, "refs/private/tenant"],
    title: `Update failure: ${id} (`,
  })),
];
it.each(diagnostics)("publishes only bounded diagnostic facts: $name", async (entry) => {
  const prepared = await report({
    reason: entry.reason,
    steps: [
      step(entry.phase ?? "verify", {
        exitCode: entry.exitCode === undefined ? 1 : entry.exitCode,
        ...(entry.fact ? { failureFacts: [entry.fact] } : {}),
      }),
    ],
  });
  expectText(prepared.body, entry.includes, entry.excludes);
  if (entry.title) {
    expect(prepared.title).toContain(entry.title);
  }
});

it("preserves classified destination ownership and recovery without exposing usernames", async () => {
  const redaction = { env: { HOME: "/Users/Fixture Owner" }, stateDir: "/report-test-state" };
  const fact = createUpdateFailureFact(
    {
      check: "package-install",
      code: "global-install-foreign-destination",
      message: "Private arbitrary diagnostic text /Users/Fixture Owner/private",
      destination: {
        ownership: "foreign",
        cause: "package-mismatch",
        destinationKind: "npm-global",
        prefix: "/home/Other Owner/.npm-global",
        packageRoot: "/home/Other Owner/.npm-global/lib/node_modules/openclaw",
        runningRoot: "/Users/Fixture Owner/.npm-global/lib/node_modules/openclaw",
        runningPrefix: "/Users/Fixture Owner/.npm-global",
        launcher: "/home/Other Owner/.npm-global/bin/openclaw",
        launcherTarget: "/home/Other Owner/openclaw.mjs\nprivate-second-line",
      },
    },
    redaction.env,
  );
  const failed = step("package-install", { failureFacts: [fact] });
  for (const recorded of [false, true]) {
    const prepared = await report(
      { reason: "global-install-foreign-destination", steps: recorded ? [] : [failed] },
      recorded
        ? { recordedRun: { runId: attemptId, steps: updateRunStepsFromResultStep(failed) } }
        : {},
      redaction,
    );
    expectText(
      prepared.body,
      [
        "ownership foreign; cause package-mismatch; kind npm-global",
        "~/.npm-global/lib/node_modules/openclaw",
        "/home/[redacted-user]/.npm-global",
        "Next step:",
        "https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions",
      ],
      ["[redacted-diagnostic]", "Private arbitrary diagnostic"],
    );
    for (const text of ["Fixture Owner", "Other Owner", "private-second-line"]) {
      expect(prepared.body).not.toContain(text);
      expect(JSON.stringify(fact)).not.toContain(text);
    }
  }
});

it("includes every named lint finding using public diagnostic redaction", async () => {
  const prepared = await report({
    reason: "doctor-failed",
    steps: [
      step("post-plugin-doctor-lint", {
        command: "doctor --lint --json",
        cwd: "/candidate",
        doctorLintFindings: Array.from({ length: 40 }, (_, index) => ({
          checkId: "core/doctor/security",
          severity: index === 0 ? "error" : "warning",
          message: "EACCES: permission denied",
          requirement: `private-customer-requirement-${index}`,
        })),
      }),
    ],
  });
  expect(
    prepared.body.match(/Doctor lint (?:error|warning) \[core\/doctor\/security\]/gu),
  ).toHaveLength(40);
  expectText(
    prepared.body,
    ["EACCES", "Permission denied", "- Failed phase: post-plugin-doctor-lint\n"],
    ["private-customer-requirement"],
  );
  expect(prepared.title).toMatch(/^Update failure: post-plugin-doctor-lint \(/u);
});

it.each([
  ...[
    "Package rollback launcher backup changed",
    "Package rollback verification timed out",
    "Package rollback verification failed",
  ].map((cause) => ({
    source: "rollback",
    diagnostic: true,
    cause,
  })),
  ...[
    { source: "stderr", diagnostic: true },
    { source: "stderr", diagnostic: false },
    { source: "facts-and-stderr", diagnostic: true },
    { source: "recorded-detail", diagnostic: true },
  ].map(({ source, diagnostic }) => ({ source, diagnostic, cause: "" })),
])(
  "retains a recognized exit cause from $source ($diagnostic, $cause)",
  async ({ source, diagnostic, cause }) => {
    const stderr = [
      "npm warn private-package from https://private-host.example/registry",
      ...(diagnostic
        ? [
            "npm ERR! code EACCES",
            "npm ERR! EACCES: permission denied, mkdir '/private/example/cache'",
          ]
        : []),
      "npm ERR! log: /private/example/npm.log",
    ].join("\n");
    const failed = step(source === "rollback" ? "package-swap" : "global update", {
      command: "npm install -g openclaw@2026.9.4",
      cwd: "/candidate",
      stderrTail: stderr,
      ...(source === "facts-and-stderr"
        ? {
            failureFacts: [
              { check: "package-install", code: "EACCES", message: "npm warn private-package" },
            ],
          }
        : {}),
    });
    const recorded = source === "rollback" || source === "recorded-detail";
    const prepared = await report(
      {
        reason: source === "rollback" ? undefined : "global-install-failed",
        steps: recorded ? [] : [failed],
      },
      recorded
        ? {
            recordedRun: {
              runId: attemptId,
              steps:
                source === "rollback"
                  ? updateRunStepsFromResultStep({
                      name: "package-swap",
                      exitCode: 1,
                      stderrTail: `${cause}: /private/customer/launcher. Installation recovery is unverified; inspect the installation and backups before restarting.`,
                    })
                  : [{ step: "global update", status: "failed", exitCode: 1, detail: stderr }],
            },
          }
        : {},
    );
    if (source === "rollback") {
      expectText(
        prepared.body,
        [`Failed phase package-swap: exit 1 (${cause})`],
        ["/private/customer", "Installation recovery is unverified"],
      );
    } else {
      expectText(
        prepared.body,
        [
          `- Failed phase package-install: exit 1${diagnostic ? " (EACCES; Permission denied)" : ""}\n`,
        ],
        ["private-package", "private-host.example", "/private/example", "npm.log"],
      );
      expect(prepared.title).toMatch(/^Update failure: package-install \(/u);
    }
  },
);

it.each(["matching", "foreign", "compact", "measured", "earlier", "alias"] as const)(
  "projects durable failure history without losing authority or order: %s",
  async (kind) => {
    const finalization = kind === "matching" || kind === "foreign";
    const message =
      "Doctor could not enter maintenance. Error: The update parent owns Gateway activation.";
    const earlier = kind === "earlier" || kind === "alias" ? ["activating"] : [];
    const name = kind === "alias" ? "git-fetch" : "verifying";
    const recordedName = kind === "alias" ? "git fetch" : name;
    const recordedRun: NonNullable<UpdateFailureReportInput["recordedRun"]> = {
      runId: kind === "foreign" ? "another-run" : attemptId,
      ...(finalization ? { reason: "doctor-failed", target: { kind: "package" } } : {}),
      steps: finalization
        ? [
            {
              step: "finalize:doctor",
              status: "failed",
              detail: `${message} private-customer-text\nprivate second line`,
            },
            {
              step: "warning:post-plugin-doctor",
              status: "completed",
              detail: "EACCES: permission denied at /private/customer/plugin",
            },
            { step: "finalize:package-rollback-not-needed", status: "skipped" },
          ]
        : kind === "compact"
          ? [
              { step: "custom-tool private-customer-text", status: "failed" },
              { step: "activating", status: "failed" },
              {
                step: "package rollback",
                status: "failed",
                detail: "Gateway service ownership or manager identity changed",
              },
            ]
          : [...earlier, recordedName].map((value) => ({ step: value, status: "failed" })),
    };
    const prepared = await report(
      {
        mode: finalization ? "unknown" : "git",
        reason: finalization
          ? undefined
          : kind === "compact"
            ? "state-migrated-no-rollback"
            : "verification-failed",
        steps:
          finalization || kind === "compact"
            ? []
            : [step(name, { command: "not copied", cwd: "/private", exitCode: 7 })],
      },
      { recordedRun },
    );
    if (finalization) {
      const matches = kind === "matching";
      expectText(
        prepared.body,
        [
          `Reason code: ${matches ? "doctor-failed" : "unknown"}`,
          `Update mode: ${matches ? "package" : "unknown"}`,
        ],
        ["private-customer-text", "private second line", "/private/customer"],
      );
      for (const text of [
        message,
        "package rollback not needed: no package mutation",
        "## Warnings\n\n- EACCES; Permission denied",
      ]) {
        expect(prepared.body.includes(text)).toBe(matches);
      }
    } else if (kind === "compact") {
      expectText(
        prepared.body,
        [
          "- Failed phase: package-rollback\n",
          "Failed phase activating: exit unknown",
          "Failed phase package-rollback: exit unknown",
          "Failed phase [redacted-command]: exit unknown",
        ],
        ["private-customer-text", "Gateway service ownership"],
      );
    } else {
      expectText(prepared.body, [`- Failed phase: ${name}\n`, `Failed phase ${name}: exit 7`]);
      expect(prepared.body.split(`Failed phase ${name}:`)).toHaveLength(2);
      for (const phase of earlier) {
        expect(prepared.body.indexOf(`Failed phase ${phase}: exit unknown`)).toBeGreaterThan(-1);
        expect(prepared.body.indexOf(`Failed phase ${phase}: exit unknown`)).toBeLessThan(
          prepared.body.indexOf(`Failed phase ${name}: exit 7`),
        );
      }
    }
  },
);

it.each(["step", "plugin-summary"])(
  "reports private-safe warnings from %s without changing the failed phase",
  async (source) => {
    const message = "EACCES: permission denied at /private/customer/plugin token=synthetic-token";
    const result: Partial<UpdateRunResult> = {
      steps: [
        ...(source === "step"
          ? [
              step("post-plugin-doctor", {
                command: "doctor --fix",
                cwd: "/candidate",
                advisory: { kind: "recoverable-maintenance", message },
              }),
            ]
          : []),
        step("verifying"),
      ],
      ...(source === "plugin-summary"
        ? {
            postUpdate: {
              plugins: {
                status: "warning",
                changed: true,
                warnings: ["discord", "private-customer-plugin"].map((pluginId) => ({
                  pluginId,
                  reason: "post-plugin-doctor-execution-failed",
                  message,
                  guidance: ["custom-tool private-customer-command"],
                })),
                sync: {
                  changed: false,
                  switchedToBundled: [],
                  switchedToNpm: [],
                  warnings: [],
                  errors: [],
                },
                npm: { changed: false, outcomes: [] },
                integrityDrifts: [],
              },
            },
          }
        : {}),
    };
    const prepared = await report(result);
    expectText(
      prepared.body,
      ["## Warnings", "EACCES; Permission denied", "- Failed phase: verifying\n"],
      [
        "Failed phase post-plugin-doctor",
        "private-customer",
        "/private/customer",
        "synthetic-token",
      ],
    );
    if (source === "plugin-summary") {
      expectText(prepared.body, [
        "Plugin convergence (post-plugin-doctor-execution-failed); plugin discord",
        "plugin [redacted-plugin]",
      ]);
    }
    await expect(report({ ...result, status: "ok" })).rejects.toThrow(
      "Only a final failed update can be reported.",
    );
  },
);

type RecoveryCase = {
  name: string;
  result: Partial<UpdateRunResult>;
  recordedRun?: UpdateFailureReportInput["recordedRun"];
  target?: string;
  includes: string[];
  excludes?: string[];
};
const recoveryCases: RecoveryCase[] = [
  {
    name: "candidate repair refused before activation",
    target: "version 2026.9.4",
    result: {
      reason: "repair-requires-config-change",
      before: { version: "2026.9.3" },
      after: { version: "2026.9.3" },
      steps: [step("repairing", { command: "repair staged candidate", cwd: "/candidate" })],
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    },
    includes: [
      "Failed phase: repairing",
      "After version: 2026.9.3",
      "Recovery outcome: not verified (runtime-verification-failed)",
    ],
    excludes: ["rollback"],
  },
  ...[
    { healthy: true, code: undefined, expected: "verified serving 2026.9.5" },
    { healthy: false, code: "stopped-free", expected: "not serving (stopped-free)" },
    {
      healthy: false,
      code: "private-probe-identifier",
      expected: "recovery check failed (gateway-probe-failed)",
    },
  ].map(({ healthy, code, expected }): RecoveryCase => ({
    name: `observed ${expected}`,
    recordedRun: {
      runId: attemptId,
      steps: [],
      verification: {
        runningVersion: "2026.9.4",
        versionMatch: true,
        readyz: true,
        settled: true,
      },
    },
    result: {
      reason: "post-update-plugins",
      after: { version: "2026.9.5" },
      recovery: healthy
        ? { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" }
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [
        step("gateway recovery verification", {
          command: "gateway verification",
          cwd: "/fixture",
          exitCode: healthy ? 0 : 1,
          ...(code ? { failureFacts: [{ check: "settled", code }] } : {}),
        }),
      ],
    },
    includes: [`Recovery outcome: ${expected}`],
    excludes: ["not verified", "private-probe-identifier"],
  })),
  ...(
    [
      { service: undefined, outcome: "verified safe to restart" },
      { service: "healthy", outcome: "Gateway serving 2026.9.4; health verified" },
      {
        service: "failed",
        reason: "restart-unhealthy",
        outcome:
          "runtime files verified; Gateway health failed (restart-unhealthy). Run `openclaw gateway status --deep` to check the serving version and readiness.",
      },
      {
        service: "healthy",
        packageRollbackVerified: true,
        outcome: "package rollback verified; Gateway serving 2026.9.4; health verified",
      },
      {
        service: "failed",
        packageRollbackVerified: true,
        reason: "channel-errors",
        outcome:
          "package rollback verified (2026.9.4); Gateway health failed (channel-errors). Run `openclaw gateway status --deep` to check the serving version and readiness.",
      },
      {
        service: undefined,
        packageRollbackVerified: true,
        reason: "gateway-readiness-pending",
        outcome:
          "package rollback verified (2026.9.4); Gateway health unverified (gateway-readiness-pending). Run `openclaw gateway status --deep` to check the serving version and readiness.",
      },
    ] as const
  ).map(({ outcome, ...recovery }): RecoveryCase => ({
    name: outcome,
    result: {
      reason: "runtime-verification-failed",
      recovery: { serviceRestartSafe: true, version: "2026.9.4", ...recovery },
    },
    includes: [`- Recovery outcome: ${outcome}\n`],
  })),
];
it.each(recoveryCases)(
  "reports only the observed recovery outcome: $name",
  async ({ result, recordedRun, target, includes, excludes }) => {
    const prepared = await report(result, { recordedRun, target });
    expectText(prepared.body, includes);
    for (const text of excludes ?? []) {
      expect(prepared.body.toLowerCase()).not.toContain(text);
    }
  },
);

type PublicFieldCase = {
  name: string;
  result?: Partial<UpdateRunResult>;
  target?: string;
  includes: string[];
};
const publicFields: PublicFieldCase[] = [
  ...["custom-tool private-customer-text", "custom-tool;private-customer-text"].map((value) => ({
    name: value,
    result: { reason: value },
    includes: ["- Reason code: [redacted-command]\n"],
  })),
  ...["origin/main@abcdef", "🦞".repeat(5)].map((value) => ({
    name: value,
    result: { reason: value },
    includes: [`- Reason code: ${value}\n`],
  })),
  ...["\n", "\u2028"].map((separator) => ({
    name: `scalar lines separated by ${JSON.stringify(separator)}`,
    result: {
      reason: ["build", "custom-tool private-customer-text", "linux/arm64"].join(separator),
    },
    includes: [
      `- Reason code: ${["build", "[redacted-command]", "linux/arm64"].join(separator)}\n`,
    ],
  })),
  ...["version 2026.9.1+build.abc", "stable channel", "extended-stable channel"].map((target) => ({
    name: target,
    target,
    result: { reason: "build-failed" },
    includes: [`- Update target: ${target}\n`],
  })),
  ...["version private-customer-text", "stable channel private-customer-text"].map((target) => ({
    name: target,
    target,
    result: { reason: "build-failed" },
    includes: ["- Update target: [redacted-command]\n"],
  })),
  {
    name: "arbitrary arguments across report fields",
    target: 'custom-updater --customer "private-customer-text"',
    result: {
      reason: 'Command failed: python -c "private-customer-text"',
      before: { version: "custom-tool private-customer-text", sha: "/private-customer-text" },
      after: {
        version: "C:\\private-customer-text",
        sha: "~\\private-customer-text",
        buildId: '"PowerShell.EXE" -EncodedCommand private-customer-text',
      },
      steps: [
        step('ruby -e "private-customer-text"', {
          command: "never copied",
          cwd: "/private",
          exitCode: 7,
        }),
      ],
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    },
    includes: ["exit 7", "Update mode: npm", "Recovery outcome: not verified"],
  },
];
it.each(publicFields)(
  "bounds public report fields: $name",
  async ({ result, target, includes }) => {
    const prepared = await report(result, { target });
    expectText(prepared.body, includes, ["private-customer-text"]);
  },
);
