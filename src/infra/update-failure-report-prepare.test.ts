import { expect, it } from "vitest";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import { DeferredPluginMigrationConflictError } from "./deferred-plugin-migrations.js";
import {
  createUpdateErrorFact,
  createUpdateFailureFact,
  type UpdateFailureFact,
} from "./update-failure-facts.js";
import { preparePublicUpdateFailureIdentifiers } from "./update-failure-public-identifiers.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { failedUpdateRun } from "./update-failure-report.test-support.js";
import type { UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";

await preparePublicUpdateFailureIdentifiers();
const context = { env: {}, stateDir: "/report-test-state" };
function step(name: string, fields: Partial<UpdateRunStep> = {}): UpdateRunStep {
  return { step: name, status: "failed", exitCode: 1, ...fields };
}
function report(fields: Partial<UpdateRunRecord> = {}) {
  return prepareUpdateFailureReport(failedUpdateRun(fields), context);
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
    name: "arbitrary exception prose remains local",
    fact: {
      check: "readyz",
      code: "Error",
      errorName: "Error",
      message: "Validation refused for customer AcmeInternal during merger planning",
    },
    includes: ["Details retained locally"],
    excludes: ["AcmeInternal", "merger planning", "Validation refused"],
  },
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
        [
          "fatal: unable to access 'https://private-user",
          "synthetic-private-token@private-host.example/repo.git/': Could not resolve host: private-host.example",
        ].join(":"),
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

it.each(["running", "succeeded", "skipped"] as const)(
  "rejects non-reportable %s rows",
  async (status) => {
    await expect(report({ status, reason: "already-current" })).rejects.toThrow(
      "Only a final failed update can be reported.",
    );
  },
);

it("binds reviewed identities and recorded verification without probing current health", async () => {
  const first = await report({
    verification: { runningVersion: "2026.8.1", readyz: true },
  });
  const next = await report({
    target: { version: "2026.8.3" },
    verification: { runningVersion: "2026.8.1", readyz: true },
  });
  expect(first.body).toContain("Recorded running version: 2026.8.1");
  expect(first.body).toContain("Update target: 2026.8.2");
  expect(next.previewDigest).not.toBe(first.previewDigest);
});

it("bounds private arguments and paths in row fields", async () => {
  const prepared = await report({
    reason: 'Command failed: python -c "private-customer-text"',
    target: { version: "/private-customer-text" },
    before: { version: "custom-tool private-customer-text" },
    after: { buildId: "C:\\private-customer-text" },
    steps: [step('ruby -e "private-customer-text"', { exitCode: 7 })],
  });
  expect(prepared.body).toContain("exit 7");
  expect(prepared.body).not.toContain("private-customer-text");
  expect(Buffer.byteLength(prepared.body)).toBeLessThanOrEqual(16_000);
});

it.each([
  {
    code: "update-executor-owned",
    sentence: "Another update executor owns this installation. Run openclaw update status",
    // The executor admission's refusal (its producer is covered in update-repair-cancellation).
    error: () => {
      throw Object.assign(
        new UpdateCommandRecoveryPendingError(
          "Another update executor owns this installation. It retains cancelled update custody (owner jdoe-laptop:4242).",
        ),
        { code: "update-executor-owned" },
      );
    },
  },
  {
    code: "plugin-migration-obligations-changed",
    sentence: "Plugin migration obligations changed while Doctor was repairing",
    error: () => {
      const pending = { pluginId: "acme-crm-sync", reason: "acme", command: "acme" };
      throw new DeferredPluginMigrationConflictError([pending], {
        expected: [{ ...pending, pluginId: "acme-billing" }],
      });
    },
  },
])(
  "publishes only the throw site's fixed sentence for $code",
  async ({ code, sentence, error }) => {
    let thrown: unknown;
    try {
      error();
    } catch (caught) {
      thrown = caught;
    }
    const prepared = await report({
      steps: [step("update", { failureFacts: [createUpdateErrorFact("update", thrown, {})] })],
    });
    expectText(prepared.body, [`(${code})`, `: ${sentence}`], /jdoe|acme/u);
  },
);

it("publishes release identities only in the shapes OpenClaw writes", async () => {
  const prepared = await report({
    target: { tag: "acme-canary" },
    before: { version: "2026.8.1-acmecorp.internal", sha: "jdoe-laptop" },
    after: { version: "2026.8.2+buildbox-acme", buildId: "acme-ci-7781" },
    verification: {
      rollbackOutcome: {
        status: "failed",
        reason: "restore failed for jdoe@acme.example on buildbox-acme tenant AcmeBilling",
      },
    },
  });
  expectText(
    prepared.body,
    [
      "Update target: [redacted-tag]",
      "Before version: [redacted-version]",
      "Before sha: [redacted-sha]",
      "After build: [redacted-build]",
      "Rollback outcome: attempted; failed\n",
    ],
    /acme|jdoe|buildbox/iu,
  );
});

it("keeps OpenClaw correction releases and Git release tags", async () => {
  const prepared = await report({
    target: { tag: "v2026.11.10" },
    before: { version: "2026.11.10-1", sha: "6ea542fd97e2" },
    after: { buildId: "2026.11.10-1-release-6ea542fd97e2-2026-11-27T19-00-13.889Z" },
  });
  expectText(prepared.body, [
    "Update target: v2026.11.10",
    "Before version: 2026.11.10-1",
    "Before sha: 6ea542fd97e2",
    "After build: 2026.11.10-1-release-6ea542fd97e2-2026-11-27T19-00-13.889Z",
  ]);
});
