import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, vi } from "vitest";
import { buildRuntimeProbeEnv } from "../../daemon/runtime-paths.js";
import * as containerEnvironment from "../../infra/container-environment.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateRecoveryStep } from "../../shared/update-outcome.js";
import * as versionManagerPath from "../../shared/version-manager-path.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";

const nodeRuntimeVersions = new Map<string, NodeJS.ProcessVersions>();

export function getNodeRuntimeFixture() {
  const nodeExecutable = resolveTestNodeExecPath();
  let versions = nodeRuntimeVersions.get(nodeExecutable);
  if (!versions) {
    // Bun's Node compatibility version is not the selected executable's version.
    versions = process.versions.bun
      ? (JSON.parse(
          execFileSync(nodeExecutable, ["-p", "JSON.stringify(process.versions)"], {
            encoding: "utf8",
            timeout: 5_000,
            env: {
              ...buildRuntimeProbeEnv(process.env),
              HOME: process.env.HOME,
              OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
            },
          }),
        ) as NodeJS.ProcessVersions)
      : { ...process.versions };
    nodeRuntimeVersions.set(nodeExecutable, versions);
  }
  const sqliteVersion = versions.sqlite;
  if (!sqliteVersion) {
    throw new Error("The Node runtime fixture requires a SQLite version");
  }
  return { execPath: nodeExecutable, versions: { ...versions, sqlite: sqliteVersion } };
}

export function stubNodeRuntime() {
  const runtime = getNodeRuntimeFixture();
  vi.spyOn(process, "execPath", "get").mockReturnValue(runtime.execPath);
  vi.spyOn(process, "versions", "get").mockReturnValue(runtime.versions);
  vi.spyOn(process, "version", "get").mockReturnValue(`v${runtime.versions.node}`);
  return runtime;
}

export function mockNonContainerSystemRuntime(): void {
  vi.spyOn(versionManagerPath, "resolveNodeVersionManager").mockReturnValue("system");
  vi.spyOn(containerEnvironment, "isContainerEnvironment").mockReturnValue(false);
}

export function expectedRuntimeSelectionCommand(manager: "nvm" | "fnm", version: string): string {
  return process.platform === "win32"
    ? `${manager} install ${version}; if ($LASTEXITCODE -eq 0) { ${manager} use ${version} }`
    : `${manager} install ${version} && ${manager} use ${version}`;
}

const clearedContext =
  "unset OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_GATEWAY_PORT OPENCLAW_LAUNCHD_LABEL OPENCLAW_SYSTEMD_UNIT OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_WORKSPACE_DIR";
const instruction = (kind: UpdateRecoveryStep["kind"], text: string): UpdateRecoveryStep => ({
  kind,
  instruction: text,
});

// Independent operator-facing fixtures shared by CLI and preflight boundary tests.
export function expectedRuntimeRecoverySteps(
  node: string,
  root?: string,
  version?: string,
  context?: string,
  pinnedServiceNode?: string,
): UpdateRecoveryStep[] {
  const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
  const steps: (UpdateRecoveryStep | undefined)[] = [
    instruction(
      "preserve-context",
      "Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
    ),
    context ? { kind: "preserve-context", command: context } : undefined,
    instruction(
      "select-runtime",
      `Install and select Node ${node} using your system package manager or https://nodejs.org/en/download.`,
    ),
    pinnedServiceNode
      ? instruction(
          "select-runtime",
          `The Gateway service still selects ${pinnedServiceNode}. Before continuing, have its deployment owner select Node ${node} in the service definition while retaining its installation, service account, and state/config selectors. Switching the shell runtime alone does not update that service definition.`,
        )
      : undefined,
    root
      ? {
          kind: "continue-update",
          command: `node ${quote(path.join(root, "openclaw.mjs"))} update${version !== undefined ? ` --tag ${version}` : ""}`,
        }
      : instruction(
          "continue-update",
          "Run this installation's absolute openclaw.mjs launcher with the selected Node and the update command to recheck package and service ownership before installation.",
        ),
  ];
  return steps.filter((step): step is UpdateRecoveryStep => step !== undefined);
}

export function expectedPlainRecovery(
  version: string,
  node: string,
  service: "refresh" | "owner" | "absent" = "owner",
  context = service === "refresh" ? clearedContext : undefined,
  root?: string,
  pinnedServiceNode?: string,
): string {
  return [
    "Recovery:",
    ...expectedRuntimeRecoverySteps(node, root, version, context, pinnedServiceNode).map(
      (step, index) =>
        `${index + 1}. ${"command" in step ? `Run \`${step.command}\`.` : step.instruction}`,
    ),
  ].join("\n");
}

export const unsupportedServiceRuntimeFixture = {
  status: "unsupported",
  version: "22.18.0",
  sqliteVersion: "3.51.3",
  nodeSharedSqlite: false,
  sqliteProbe: { available: true, version: "3.51.3", text: false, blob: true, json: true },
  capabilityError: "Node 22.18.0: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)",
} as const;

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
      failedStep: { recoverySteps: expectedRuntimeRecoverySteps("24.22.1", root) },
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
