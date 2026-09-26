import path from "node:path";
import { expect } from "vitest";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateRecoveryStep } from "../../shared/update-outcome.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";

export const alreadyCurrentConvergenceCases = [
  { restart: true, running: true, failure: undefined },
  { restart: false, running: true, failure: undefined },
  { restart: true, running: false, failure: undefined },
  { restart: true, running: true, failure: "doctor" },
  { restart: true, running: true, failure: "stop" },
  { restart: true, running: true, failure: undefined, platform: "linux" as const },
  { restart: true, running: true, failure: "changed owner" },
];

export function alreadyCurrentHandoffCases(version: string) {
  return [
    {
      packageInstallSpec: "file:/owned/candidate.tgz",
      channel: "stable" as const,
      expectedTag: "file:/owned/candidate.tgz",
    },
    {
      packageInstallSpec: "https://example.invalid/candidate.tgz",
      channel: "stable" as const,
      expectedTag: "https://example.invalid/candidate.tgz",
    },
    {
      packageInstallSpec: `openclaw@${version}`,
      channel: "stable" as const,
      expectedTag: version,
    },
    {
      packageInstallSpec: `openclaw@${version}`,
      channel: "extended-stable" as const,
      expectedTag: undefined,
    },
  ];
}

export function expectedRuntimeSelectionCommand(manager: "nvm" | "fnm", version: string): string {
  return process.platform === "win32"
    ? `${manager} install ${version}; if ($LASTEXITCODE -eq 0) { ${manager} use ${version} }`
    : `${manager} install ${version} && ${manager} use ${version}`;
}

// Independent operator-facing fixtures shared by CLI and preflight boundary tests.
export function expectedPlainRecovery(
  version: string,
  node: string,
  service: "refresh" | "owner" | "absent" = "owner",
  context = service === "refresh"
    ? "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR"
    : undefined,
  root?: string,
  pinnedServiceNode?: string,
): string {
  return [
    "Recovery:",
    "1. Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    ...(context ? [`2. Run \`${context}\`.`] : []),
    `2. Install and select Node ${node} using your system package manager or https://nodejs.org/en/download.`,
    ...(pinnedServiceNode
      ? [
          `3. The Gateway service still selects ${pinnedServiceNode}. Before continuing, have its deployment owner select Node ${node} in the service definition while retaining its installation, service account, and state/config selectors. Switching the shell runtime alone does not update that service definition.`,
        ]
      : []),
    root
      ? `3. Run \`node ${process.platform === "win32" ? quotePowerShellArg(path.join(root, "openclaw.mjs")) : quoteCliArg(path.join(root, "openclaw.mjs"))} update --tag ${version}\`.`
      : "3. Run this installation's absolute openclaw.mjs launcher with the selected Node and the update command to recheck package and service ownership before installation.",
  ]
    .map((line, index) => (index ? line.replace(/^\d+\./, `${index}.`) : line))
    .join("\n");
}

export function expectedManagedRuntimeRecoverySteps(
  manager: "nvm" | "system",
  root: string,
): UpdateRecoveryStep[] {
  return [
    {
      kind: "preserve-context",
      instruction:
        "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    },
    {
      kind: "preserve-context",
      command:
        "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR",
    },
    manager === "nvm"
      ? { kind: "select-runtime", command: expectedRuntimeSelectionCommand("nvm", "24.16.0") }
      : {
          kind: "select-runtime",
          instruction:
            "Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.",
        },
    {
      kind: "continue-update",
      command: `node ${process.platform === "win32" ? quotePowerShellArg(path.join(root, "openclaw.mjs")) : quoteCliArg(path.join(root, "openclaw.mjs"))} update --tag 2026.5.20`,
    },
  ];
}

export const unsupportedServiceRuntimeFixture = {
  status: "unsupported",
  version: "22.18.0",
  sqliteVersion: "3.51.3",
  nodeSharedSqlite: false,
  sqliteProbe: { available: true, version: "3.51.3", text: false, blob: true, json: true },
  capabilityError: "Node 22.18.0: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)",
} as const;

export function runtimeRecoveryCommandFixture(serviceNode: string) {
  return async (argv: readonly string[]) =>
    createCommandResult({
      stdout:
        argv[0] === serviceNode && argv[1] === "--version"
          ? "v22.18.0\n"
          : argv[0] === "npm" && argv[1] === "--version"
            ? "12.0.0\n"
            : "",
    });
}

export function currentGitCoreFixture(root: string, version: string) {
  const outcome: UpdateRunResult = {
    status: "skipped",
    mode: "git",
    root,
    reason: "already-current",
    before: { version, sha: "abc123" },
    steps: [],
    durationMs: 1,
  };
  const entry = path.join(root, "openclaw.mjs");
  const launcher = `node ${process.platform === "win32" ? quotePowerShellArg(entry) : quoteCliArg(entry)}`;
  const recoverySteps: UpdateRecoveryStep[] = [
    {
      kind: "preserve-context",
      instruction:
        "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    },
    {
      kind: "select-runtime",
      instruction:
        "Install and select Node 24.16.0 using your system package manager or https://nodejs.org/en/download.",
    },
    { kind: "continue-update", command: `${launcher} update` },
  ];
  return {
    outcome,
    converged: {
      status: "skipped",
      reason: "already-current",
      after: { version, sha: "abc123" },
      postUpdate: { plugins: { changed: false } },
    },
    runtimeRefusal: {
      status: "error",
      reason: "node-runtime-preflight",
      failedStep: { recoverySteps },
    },
  };
}

export function expectInterruptedDoctorPackageRollback(runs: UpdateRunRecord[]): void {
  expect(runs).toMatchObject([
    {
      phase: "finished",
      status: "failed",
      reason: "doctor-failed",
      verification: {
        recovery: {
          serviceRestartSafe: false,
          packageRollbackVerified: true,
          reason: "runtime-verification-failed",
        },
        rollbackOutcome: { status: "succeeded" },
      },
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "openclaw doctor",
          status: "failed",
          detail: expect.stringContaining("interrupted lifecycle"),
          failureFacts: expect.arrayContaining([
            expect.objectContaining({
              check: "openclaw doctor",
              code: "Error",
              message: "interrupted lifecycle",
            }),
          ]),
        }),
      ]),
    },
  ]);
}
