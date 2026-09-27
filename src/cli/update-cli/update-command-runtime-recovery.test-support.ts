import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateRecoveryStep } from "../../shared/update-outcome.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import { getMockCallOutput, type CliMockOutputRuntime } from "../test-runtime-capture.js";

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

// Windows cannot prove native database displacement custody; retain both generations.
export async function expectWindowsRecovery(
  root: string,
  runtime: CliMockOutputRuntime,
  failureMessage: "update invariant broke" | "interrupted lifecycle",
): Promise<void> {
  const launcher = fs.access(path.join(root, "dist", "index.js"));
  if (failureMessage === "update invariant broke") {
    await expect(launcher).rejects.toHaveProperty("code", "ENOENT");
  } else {
    await expect(launcher).resolves.toBeUndefined();
  }
  expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
    version: "9999.0.0",
  });
  expect(getMockCallOutput(vi.mocked(runtime.error))).toContain(
    "Native database displacement custody is unavailable",
  );
  expect(getMockCallOutput(vi.mocked(runtime.log))).toContain(failureMessage);
  expect(listUpdateRuns({ limit: 1 })).toMatchObject([
    { phase: "activating", status: "running", finishedAtMs: null, verification: {} },
  ]);
  const retained = (await fs.readdir(path.dirname(root))).find((name) =>
    /^[.]openclaw[.]package-backup-[0-9]+-[0-9]+$/u.test(name),
  );
  const backup = path.join(path.dirname(root), expectDefined(retained, "retained package"));
  expect(JSON.parse(await fs.readFile(path.join(backup, "package.json"), "utf8"))).toMatchObject({
    version: "1.0.0",
  });
  await expect(fs.access(path.join(backup, "dist", "index.js"))).resolves.toBeUndefined();
  const snapshots = await fs.readdir(backup + ".databases", {
    recursive: true,
    withFileTypes: true,
  });
  const databases = snapshots.filter((entry) => entry.isFile());
  expect(databases.length).toBeGreaterThan(0);
  for (const database of databases) {
    const bytes = await fs.readFile(path.join(database.parentPath, database.name));
    expect(bytes.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  }
}
