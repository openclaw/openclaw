import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import type { UpdateCommandRecoveryState } from "./update-command-service-maintenance.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

// Component evidence: simulate the candidate's failed result and state restoration.
// Keep the migrated parent, real bound child lifetime, executor/SQLite lease,
// terminal owner, recovery unwind, ledger, and JSON renderer real. No full migration is claimed.
vi.mock("./update-command-rollback.js", () => ({ rollbackFailedUpdate: vi.fn() }));
vi.mock("../../process/exec.js", async (original) => {
  const actual = await original<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runUtf8CommandWithTimeout: vi.fn(async (argv, options) => {
      if (argv.at(-1) === "--check") {
        return {
          stdout: JSON.stringify({
            executorDelegation: "pid-start-v1",
            updateRecovery: "parent-v1",
          }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          cleanup: "normal",
        };
      }
      // The real process runner binds this disposable child before sending input
      // and joins it before the parent can resume its admitted executor.
      return actual.runUtf8CommandWithTimeout(
        [
          process.execPath,
          "-e",
          `
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          require("node:fs").writeFileSync(value.resultPath, JSON.stringify({
            result: { ...value.params.result, status: "error", reason: "restart-unhealthy" },
            exitCode: 1, executorDelegation: "pid-start-v1", recoveryRequired: true
          }));
        });
      `,
        ],
        options,
      );
    }),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let temporary: string;
beforeEach(async () => {
  base = await fs.realpath(dirs.make("migrated-terminal-"));
  temporary = path.join(base, "private-tmp");
  await fs.mkdir(temporary, { mode: 0o700 });
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "");
  vi.mocked(runUtf8CommandWithTimeout).mockClear();
  vi.mocked(rollbackFailedUpdate).mockReset();
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Scenario =
  | "normal"
  | "cleanup-throws"
  | "release-fails"
  | "revoked"
  | "sibling"
  | "not-rolled-back";
async function scenario(kind: Scenario) {
  const root = path.join(base, "package");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
  const run: NonNullable<FinishUpdateParams["opts"]["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: process.env }).runId,
    env: { ...process.env },
  };
  const events: string[] = [];
  const output: unknown[] = [];
  const errors: string[] = [];
  let executorExited = false;
  const publication: { executorExited: boolean; lease: string }[] = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    events.push("print");
    output.push(structuredClone(value));
    publication.push({ executorExited, lease: createManagedHandoffLeaseStore().read(root).kind });
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((value) => errors.push(String(value)));
  const completionSnapshots: { status?: string; printed: number }[] = [];
  const complete = vi.fn<NonNullable<FinishUpdateParams["packageTransaction"]>["complete"]>(
    async (_outcome, assertCurrent) => {
      assertCurrent();
      events.push("package complete");
      completionSnapshots.push({
        status: getUpdateRun(run.runId, { env: run.env })?.status,
        printed: output.length,
      });
      await Promise.resolve();
      if (kind === "cleanup-throws") {
        throw new Error("fixture package completion failed");
      }
      events.push("package completed");
    },
  );
  const params: FinishUpdateParams = {
    mutationStarted: true,
    root,
    result: { status: "ok", mode: "npm", root, runId: run.runId, steps: [], durationMs: 0 },
    installKindChanged: false,
    configSnapshot: {
      path: path.join(base, "state", "openclaw.json"),
      exists: false,
      raw: null,
      parsed: {},
      sourceConfig: asResolvedSourceConfig({}),
      resolved: asResolvedSourceConfig({}),
      valid: true,
      runtimeConfig: asRuntimeConfig({}),
      config: asRuntimeConfig({}),
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: { json: true, run },
    packageTransaction: {
      backupRoot: path.join(root, "package-backup"),
      rollback: vi.fn(),
      complete,
    },
    updateRecoveryBackup: {
      directory: path.join(base, "capture"),
      manifestPath: path.join(base, "capture", "manifest.json"),
      manifestSha256: "a".repeat(64),
    },
    controlPlaneUpdateSentinelMeta: { sessionKey: "agent:main:terminal-component-test" },
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    packageUpdateNodeRunner: process.execPath,
    updateStepTimeoutMs: 1_000,
    rollbackBlockedReason: "state-migrated-no-rollback",
    preManagedServiceStop: {
      stopped: true,
      stoppedAtMs: 100,
      inspected: true,
      runtimeInspected: true,
      running: true,
    },
  };
  vi.mocked(rollbackFailedUpdate).mockImplementation(async (input) => {
    run.executorFence?.assertCurrent();
    events.push("parent recovery");
    return {
      result: {
        ...input.result,
        recovery: { serviceRestartSafe: true, version: "1.0.0", service: "healthy" },
      },
      stateRestored: true,
      rolledBack: kind !== "not-rolled-back",
      verifiedAtMs: 250,
    };
  });
  const mutateLease = (sql: string, key?: string) => {
    const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
    try {
      if (key) {
        db.prepare(sql).run(key);
      } else {
        db.exec(sql);
      }
    } finally {
      db.close();
    }
  };
  const recoveryState: UpdateCommandRecoveryState = { triageTarget: { root, env: run.env } };
  let injected = false;
  let failure: unknown;
  try {
    await withUpdateCommandTerminalResult(run, async () => {
      try {
        return await withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          await withUpdateCommandRecoveryUnwind(
            { ...params.opts, run },
            recoveryState,
            async () => {
              // Match updateCommandInternal: only a returned continuation completes
              // the handoff before the caller converts its nonzero exit into failure.
              recoveryState.ledgerHandoffOwned = true;
              const result = await continueMigratedUpdateInFreshProcess(params, []);
              recoveryState.ledgerHandoffCompleted = true;
              events.push("parent returned");
              if (kind === "release-fails") {
                mutateLease(
                  "CREATE TRIGGER deny_terminal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture final lease delete denied'); END",
                );
                injected = true;
              }
              if (kind === "revoked" || kind === "sibling") {
                const key = kind === "sibling" ? path.join(base, "sibling") : root;
                if (kind === "sibling") {
                  await fs.mkdir(key);
                  expect(
                    createManagedHandoffLeaseStore().acquire(key, "sibling-owner", {
                      kind: "update",
                    }).kind,
                  ).toBe("acquired");
                }
                mutateLease(
                  "UPDATE managed_update_handoffs SET owner = 'replacement' WHERE install_root = ?",
                  key,
                );
                injected = true;
              }
              if (result.exitCode !== 0) {
                throw new UpdateCommandFailure(result.result, result.exitCode, undefined, {
                  automaticTriage: result.automaticTriage,
                });
              }
            },
          );
        });
      } finally {
        executorExited = true;
        events.push("executor exited");
      }
    });
  } catch (error) {
    failure = error;
  }
  const history = getUpdateRun(run.runId, { env: run.env });
  const sentinel = await readRestartSentinel(run.env);
  expect(rollbackFailedUpdate).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledWith({ activationVerified: false }, expect.any(Function));
  expect(run.executorFence?.assertCurrent).toThrow();
  return {
    output,
    errors,
    history,
    sentinel,
    failure,
    events,
    publication,
    completionSnapshots,
    injected,
  };
}

it("defers migrated-parent ledger and print until package completion and outer executor release", async () => {
  const observed = await scenario("normal");
  expect(observed.completionSnapshots).toEqual([{ status: "running", printed: 0 }]);
  expect(observed.publication).toEqual([{ executorExited: true, lease: "absent" }]);
  expect(observed.events.indexOf("package completed")).toBeLessThan(
    observed.events.indexOf("executor exited"),
  );
  expect(observed.events.indexOf("executor exited")).toBeLessThan(observed.events.indexOf("print"));
  expect(observed.failure).toBeInstanceOf(UpdateCommandFailure);
  expect(observed.output).toHaveLength(1);
  expect(observed.history).toMatchObject({ status: "rolled-back", downtimeMs: 150 });
});

it("reports one final failure with package cleanup facts after completion throws", async () => {
  const observed = await scenario("cleanup-throws");
  expect(observed.failure).toBeInstanceOf(UpdateCommandFailure);
  expect(observed.output).toHaveLength(1);
  expect(observed.output[0]).toMatchObject({
    status: "error",
    reason: "package-backup-retention-failed",
    recovery: { serviceRestartSafe: true, version: "1.0.0", service: "healthy" },
    steps: expect.arrayContaining([
      expect.objectContaining({
        name: "global install backup retention",
        exitCode: 1,
        stderrTail: expect.stringContaining("fixture package completion failed"),
      }),
    ]),
  });
  expect(observed.publication).toEqual([{ executorExited: true, lease: "absent" }]);
  expect(observed.history).toMatchObject({
    status: "rolled-back",
    downtimeMs: 150,
    reason: "package-backup-retention-failed",
    steps: expect.arrayContaining([
      expect.objectContaining({ step: "global install backup retention", status: "failed" }),
    ]),
  });
  expect(observed.sentinel?.payload.stats?.recovery).toMatchObject({
    serviceRestartSafe: true,
    version: "1.0.0",
    service: "healthy",
  });
  expect(observed.output[0]).not.toMatchObject({
    steps: expect.arrayContaining([
      expect.objectContaining({ name: "update executor settlement" }),
    ]),
  });
  expect(observed.history?.steps).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ step: "update executor settlement" })]),
  );
});

it.each(["release-fails", "revoked"] as const)(
  "includes executor %s in one truthful migrated-parent result",
  async (kind) => {
    const observed = await scenario(kind);
    expect(observed.injected).toBe(true);
    expect(observed.failure).toBeInstanceOf(UpdateCommandFailure);
    expect(observed.output).toHaveLength(1);
    expect(observed.output[0]).toMatchObject({
      status: "error",
      reason: "update-executor-settlement-failed",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "update executor settlement", exitCode: 1 }),
      ]),
    });
    expect(observed.output[0]).not.toHaveProperty("recovery");
    expect(observed.sentinel?.payload.status).toBe("error");
    expect(observed.sentinel?.payload.stats?.reason).toBe("update-executor-settlement-failed");
    expect(observed.sentinel?.payload.stats).not.toHaveProperty("recovery");
    expect(observed.history).toMatchObject({ status: "failed" });
    expect(observed.history?.downtimeMs).toBeNull();
    expect(observed.publication[0]?.executorExited).toBe(true);
    assert(observed.failure instanceof UpdateCommandFailure);
    expect(observed.failure.result.status).toBe("error");
  },
);

it.each(["sibling", "not-rolled-back"] as const)(
  "preserves the migrated-parent %s control",
  async (kind) => {
    const observed = await scenario(kind);
    expect(observed.failure).toBeInstanceOf(UpdateCommandFailure);
    expect(observed.output).toHaveLength(1);
    expect(observed.history?.status).toBe(kind === "sibling" ? "rolled-back" : "failed");
    expect(observed.output[0]).toMatchObject({ status: "error", reason: "restart-unhealthy" });
    expect(observed.errors).toEqual([]);
  },
);
