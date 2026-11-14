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
type ExcludedText = readonly string[] | RegExp;
function expectText(body: string, includes: readonly string[], excludes: ExcludedText = []) {
  for (const text of includes) {
    expect(body).toContain(text);
  }
  if (excludes instanceof RegExp) {
    expect(body).not.toMatch(excludes);
  } else {
    for (const text of excludes) {
      expect(body).not.toContain(text);
    }
  }
}
function makeRecordedRun(
  steps: NonNullable<UpdateFailureReportInput["recordedRun"]>["steps"],
  fields: Partial<NonNullable<UpdateFailureReportInput["recordedRun"]>> = {},
) {
  return { runId: attemptId, steps, ...fields };
}
const unsafeRecovery = {
  serviceRestartSafe: false,
  reason: "runtime-verification-failed",
} as const;

type Diagnostic = {
  name: string;
  fact?: UpdateFailureFact;
  phase?: string;
  reason?: string;
  exitCode?: number | null;
  includes: string[];
  excludes?: ExcludedText;
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
        "managed handoff lease database identity changed at /home/Private Operator/lease.sqlite; recorded /Users/Private Operator/lease.sqlite; file identity changed. Run openclaw update repair.",
    },
    includes: ["managed-service-handoff-failed"],
    excludes: /Private Operator|\/home\/|\/Users\//u,
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
    excludes:
      version.endsWith("private") || version === "GLIBC_PRIVATE"
        ? /private-user|private-prefix|private-loader-text|synthetic-private-token|\/lib\/|GLIBC_/u
        : /private-user|private-prefix|private-loader-text|synthetic-private-token|\/lib\//u,
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
    excludes: suffix
      ? /private-customer-text|managed update ownership transfer failed/u
      : /private-customer-text/u,
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
      ["affectedKey", "engines.private-host.example"],
      ["affectedKey", "engines.node.private-host.example"],
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
    excludes:
      /synthetic-token-value|Example Person|example\/|secret\.json|private second line|private file/u,
  })),
  ...(
    [
      ["openclaw doctor", "package-doctor"],
      ["Checking update health cleanup", "candidate-doctor-lint-cleanup"],
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
  // Git prints its progress banner first; the closed cause must survive capture and export.
  ...(
    [
      [
        "fatal: unable to access 'https://private-user:synthetic-private-token@private-host.example/repo.git/': Could not resolve host: private-host.example",
        "unable to access; Could not resolve host",
      ],
      [
        "private-user@private-host.example: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        "Permission denied (publickey); Could not read from remote repository",
      ],
      [
        "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nfatal: early EOF",
        "EOF; RPC failed; early EOF",
      ],
      [
        "private-user@private-host.example: Permission denied (publickey,private-host).\nCONFLICT (/home/private-user/secret): openclaw-staging",
        "Permission denied",
      ],
    ] as const
  ).map(([stderr, cause]) => ({
    name: `git clone cause ${cause}`,
    phase: "git-clone",
    fact: createUpdateFailureFact({
      check: "git-clone",
      code: "command-failed",
      message: `Cloning into '/home/private-user/openclaw-staging'...\n${stderr}`,
    }),
    includes: [`Failing check git-clone (command-failed): ${cause}`],
    excludes: /private-user|private-host|synthetic-private-token|\/home\/|openclaw-staging/u,
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

it("keeps allowlisted stderr causes alongside a classified startup fact", async () => {
  const prepared = await report({
    steps: [
      step("candidate-gateway-startup", {
        failureFacts: [
          {
            check: "startupz",
            code: "candidate-startup-failed",
            message: "plugin load failed",
            pluginId: "discord",
          },
        ],
        stderrTail:
          "EACCES: permission denied at /private/customer/plugin on private-host.example token=synthetic-secret",
      }),
    ],
  });
  expectText(
    prepared.body,
    [
      "Failed phase candidate-gateway-startup: exit 1 (EACCES; Permission denied; plugin load failed: discord)",
    ],
    /\/private\/customer|private-host|synthetic-secret/u,
  );
});

it.each([
  { error: undefined, expected: undefined },
  { error: " \n", expected: undefined },
  {
    error:
      "EACCES: permission denied at /private/customer/config.json token=synthetic-secret\n" +
      "private-host.example private-customer-text\n".repeat(1000),
    expected: "EACCES; Permission denied",
  },
  { error: "custom-tool --token synthetic-secret", expected: "[redacted-diagnostic]" },
])(
  "renders only bounded public facts from the top-level error: $expected",
  async ({ error, expected }) => {
    const prepared = await report({}, { error });
    const line = prepared.body.split("\n").find((value) => value.startsWith("- Error: "));
    expect(line).toBe(expected ? `- Error: ${expected}` : undefined);
    expect(Buffer.byteLength(line?.slice("- Error: ".length) ?? "")).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(16_000);
    expectText(
      prepared.body,
      [],
      /\/private\/customer|config\.json|synthetic-secret|private-host|private-customer-text/u,
    );
  },
);

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
      recorded ? { recordedRun: makeRecordedRun(updateRunStepsFromResultStep(failed)) } : {},
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
      /\[redacted-diagnostic\]|Private arbitrary diagnostic/u,
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
  "Package rollback launcher backup changed",
  "Package rollback verification timed out",
  "Package rollback verification failed",
])("retains the recognized rollback cause: %s", async (cause) => {
  const prepared = await report(
    {},
    {
      recordedRun: makeRecordedRun(
        updateRunStepsFromResultStep({
          name: "package-swap",
          exitCode: 1,
          stderrTail: `${cause}: /private/customer/launcher. Installation recovery is unverified; inspect the installation and backups before restarting.`,
        }),
      ),
    },
  );
  expectText(
    prepared.body,
    [`Failed phase package-swap: exit 1 (${cause})`],
    /\/private\/customer|Installation recovery is unverified/u,
  );
});

it.each([
  { source: "stderr", diagnostic: true },
  { source: "stderr", diagnostic: false },
  { source: "facts-and-stderr", diagnostic: true },
  { source: "recorded-detail", diagnostic: true },
])("retains a recognized exit cause from $source ($diagnostic)", async ({ source, diagnostic }) => {
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
  const failed = step("global update", {
    stderrTail: stderr,
    failureFacts:
      source === "facts-and-stderr"
        ? [{ check: "package-install", code: "EACCES", message: "npm warn private-package" }]
        : undefined,
  });
  const recorded = source === "recorded-detail";
  const prepared = await report(
    {
      reason: "global-install-failed",
      steps: recorded ? [] : [failed],
    },
    recorded
      ? {
          recordedRun: makeRecordedRun([
            { step: "global update", status: "failed", exitCode: 1, detail: stderr },
          ]),
        }
      : {},
  );
  expectText(
    prepared.body,
    [`- Failed phase package-install: exit 1${diagnostic ? " (EACCES; Permission denied)" : ""}\n`],
    /private-package|private-host\.example|\/private\/example|npm\.log/u,
  );
  expect(prepared.title).toMatch(/^Update failure: package-install \(/u);
});

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
        /private-customer-text|private second line|\/private\/customer/u,
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
        /private-customer-text|Gateway service ownership/u,
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
    const result: Partial<UpdateRunResult> = { steps: [step("verifying")] };
    if (source === "step") {
      result.steps?.unshift(
        step("post-plugin-doctor", {
          advisory: { kind: "recoverable-maintenance", message },
        }),
      );
    } else {
      result.postUpdate = {
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
      };
    }
    const prepared = await report(result);
    expectText(
      prepared.body,
      ["## Warnings", "EACCES; Permission denied", "- Failed phase: verifying\n"],
      /Failed phase post-plugin-doctor|private-customer|\/private\/customer|synthetic-token/u,
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

type ReportCase = {
  name: string;
  result?: Partial<UpdateRunResult>;
  recordedRun?: UpdateFailureReportInput["recordedRun"];
  target?: string;
  includes: string[];
  excludes?: string[];
};
function recoveryCase(
  summary: string,
  recovery: Partial<Extract<UpdateRunResult["recovery"], { serviceRestartSafe: true }>> = {},
): ReportCase {
  const outcome = recovery.reason
    ? `${summary}. Run \`openclaw gateway status --deep\` to check the serving version and readiness.`
    : summary;
  return {
    name: outcome,
    result: {
      reason: "runtime-verification-failed",
      recovery: { serviceRestartSafe: true, version: "2026.9.4", ...recovery },
    },
    includes: [`- Recovery outcome: ${outcome}\n`],
  };
}
const recoveryCases: ReportCase[] = [
  {
    name: "candidate repair refused before activation",
    target: "version 2026.9.4",
    result: {
      reason: "repair-requires-config-change",
      before: { version: "2026.9.3" },
      after: { version: "2026.9.3" },
      steps: [step("repairing")],
      recovery: unsafeRecovery,
    },
    includes: [
      "Failed phase: repairing",
      "After version: 2026.9.3",
      "Recovery outcome: not verified (runtime-verification-failed)",
    ],
    excludes: ["rollback"],
  },
  ...(
    [
      [true, undefined, "verified serving 2026.9.5"],
      [false, "stopped-free", "not serving (stopped-free)"],
      [false, "private-probe-identifier", "recovery check failed (gateway-probe-failed)"],
    ] as const
  ).map(([healthy, code, expected]): ReportCase => ({
    name: `observed ${expected}`,
    recordedRun: makeRecordedRun([], {
      verification: { runningVersion: "2026.9.4", versionMatch: true, readyz: true, settled: true },
    }),
    result: {
      reason: "post-update-plugins",
      after: { version: "2026.9.5" },
      recovery: healthy
        ? { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" }
        : unsafeRecovery,
      steps: [
        step("gateway recovery verification", {
          exitCode: healthy ? 0 : 1,
          ...(code ? { failureFacts: [{ check: "settled", code }] } : {}),
        }),
      ],
    },
    includes: [`Recovery outcome: ${expected}`],
    excludes: ["not verified", "private-probe-identifier"],
  })),
  recoveryCase("verified safe to restart"),
  recoveryCase("Gateway serving 2026.9.4; health verified", { service: "healthy" }),
  recoveryCase("runtime files verified; Gateway health failed (restart-unhealthy)", {
    service: "failed",
    reason: "restart-unhealthy",
  }),
  recoveryCase("package rollback verified; Gateway serving 2026.9.4; health verified", {
    service: "healthy",
    packageRollbackVerified: true,
  }),
  recoveryCase("package rollback verified (2026.9.4); Gateway health failed (channel-errors)", {
    service: "failed",
    packageRollbackVerified: true,
    reason: "channel-errors",
  }),
  recoveryCase(
    "package rollback verified (2026.9.4); Gateway health unverified (gateway-readiness-pending)",
    {
      packageRollbackVerified: true,
      reason: "gateway-readiness-pending",
    },
  ),
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

type PublicField = { field: "reason" | "target"; value: string; expected: string };
it.each`
  field       | value                                                              | expected
  ${"reason"} | ${"custom-tool private-customer-text"}                             | ${"[redacted-command]"}
  ${"reason"} | ${"custom-tool;private-customer-text"}                             | ${"[redacted-command]"}
  ${"reason"} | ${"origin/main@abcdef"}                                            | ${"origin/main@abcdef"}
  ${"reason"} | ${"🦞".repeat(5)}                                                  | ${"🦞".repeat(5)}
  ${"reason"} | ${"build\ncustom-tool private-customer-text\nlinux/arm64"}         | ${"build\n[redacted-command]\nlinux/arm64"}
  ${"reason"} | ${"build\u2028custom-tool private-customer-text\u2028linux/arm64"} | ${"build\u2028[redacted-command]\u2028linux/arm64"}
  ${"target"} | ${"version 2026.9.1+build.abc"}                                    | ${"version 2026.9.1+build.abc"}
  ${"target"} | ${"stable channel"}                                                | ${"stable channel"}
  ${"target"} | ${"extended-stable channel"}                                       | ${"extended-stable channel"}
  ${"target"} | ${"version private-customer-text"}                                 | ${"[redacted-command]"}
  ${"target"} | ${"stable channel private-customer-text"}                          | ${"[redacted-command]"}
`("bounds public $field: $value", async ({ field, value, expected }: PublicField) => {
  const prepared = await report(
    { reason: field === "reason" ? value : "build-failed" },
    field === "target" ? { target: value } : {},
  );
  const label = field === "reason" ? "Reason code" : "Update target";
  expectText(prepared.body, [`- ${label}: ${expected}\n`], ["private-customer-text"]);
});

it("bounds arbitrary arguments across report fields", async () => {
  const prepared = await report(
    {
      reason: 'Command failed: python -c "private-customer-text"',
      before: { version: "custom-tool private-customer-text", sha: "/private-customer-text" },
      after: {
        version: "C:\\private-customer-text",
        sha: "~\\private-customer-text",
        buildId: '"PowerShell.EXE" -EncodedCommand private-customer-text',
      },
      steps: [step('ruby -e "private-customer-text"', { exitCode: 7 })],
      recovery: unsafeRecovery,
    },
    { target: 'custom-updater --customer "private-customer-text"' },
  );
  expectText(
    prepared.body,
    ["exit 7", "Update mode: npm", "Recovery outcome: not verified"],
    ["private-customer-text"],
  );
});
