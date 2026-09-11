import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as serviceState from "../../daemon/service.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import * as portInspection from "../../infra/ports-inspect.js";
import * as processParents from "../../infra/restart-stale-pids.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import * as recoveryBackups from "../../infra/update-recovery-backup.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import * as recoveryStore from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import * as processIdentity from "../../shared/pid-alive.js";
import {
  claimOpenClawAgentDatabaseLease,
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
  releaseOpenClawAgentDatabaseLease,
} from "../../state/openclaw-agent-db-lease.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  completeUpdateCommandBackup,
  createUpdateCommandBackup,
  preflightUpdateCommandBackup,
} from "./update-command-backup-lifecycle.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";

afterEach(() => vi.restoreAllMocks());

it.each(["current", "revoked", "replaced-run", "rebound-recovery"] as const)(
  "checks capture ownership without repeated recovery snapshots: %s",
  async (scenario) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const temporary = state.path("coordinator");
      await fs.mkdir(temporary, { mode: 0o700 });
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
      const root = state.path("install");
      await fs.mkdir(root);
      const inventoryRoot = state.path("inventory");
      await fs.mkdir(inventoryRoot);
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          fs.writeFile(path.join(inventoryRoot, `entry-${index}.txt`), "synthetic capture input"),
        ),
      );
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
        env: state.env,
      };
      const opts: UpdateCommandOptions = { run };
      const readRecovery = vi.spyOn(recoveryStore, "loadUpdateRecovery");
      const capture = recoveryBackups.createUpdateRecoveryBackup;
      let ownershipChecks = 0;
      let readsAfterCapture = 0;
      vi.spyOn(recoveryBackups, "createUpdateRecoveryBackup").mockImplementation(async (params) => {
        const recoveryReads = readRecovery.mock.calls.length;
        expect(recoveryReads).toBeGreaterThan(0);
        const result = await capture({
          ...params,
          assertOwned() {
            if (++ownershipChecks === 8) {
              if (scenario === "revoked") {
                const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
                try {
                  db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
                    "replacement",
                    root,
                  );
                } finally {
                  db.close();
                }
              } else if (scenario === "replaced-run") {
                opts.run = { ...run };
              } else if (scenario === "rebound-recovery") {
                opts.recovery = {};
              }
            }
            params.assertOwned();
          },
        });
        expect(ownershipChecks).toBeGreaterThan(8);
        expect(readRecovery.mock.calls.length).toBe(recoveryReads);
        readsAfterCapture = readRecovery.mock.calls.length;
        return result;
      });
      const execution = withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(root);
        const backup = await createUpdateCommandBackup({ opts, root, env: state.env });
        expect((await fs.stat(backup.manifestPath)).isFile()).toBe(true);
      });
      if (scenario === "current") {
        await execution;
        expect(readRecovery.mock.calls.length).toBeGreaterThan(readsAfterCapture);
      } else {
        await expect(execution).rejects.toThrow(/ownership|executor|recovery/i);
        expect(ownershipChecks).toBe(8);
      }
    });
  },
);

it.each([
  "owned child",
  "foreign child",
  "foreign Gateway",
  "unreadable parent",
  "rebound lock",
  "reused launcher",
] as const)("admits only the verified service's Gateway writer: %s", async (scenario) => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    const root = state.path("install");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
    );
    await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
    const temporary = state.path("coordinator");
    await fs.mkdir(temporary, { mode: 0o700 });
    vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
    const startTime = processIdentity.getFileLockProcessStartTime(process.pid);
    const launcherStart = processIdentity.getFileLockProcessStartTime(process.ppid);
    if (startTime === null || launcherStart === null) {
      throw new Error("Writer fixture requires known process start identities");
    }
    const lease = claimOpenClawAgentDatabaseLease({
      agentId: "main",
      path: state.path("agents", "main", "agent", "openclaw-agent.sqlite"),
      env: state.env,
    });
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
      env: state.env,
    };
    try {
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(root);
        let inspected = false;
        const originalStartTime = processIdentity.getFileLockProcessStartTime;
        vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid) =>
          pid === process.ppid && inspected && scenario === "reused launcher"
            ? launcherStart + 1
            : originalStartTime(pid),
        );
        let lockReads = 0;
        vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockImplementation(async () => {
          inspected = ++lockReads > 1;
          return {
            pid: scenario === "foreign Gateway" ? process.ppid : process.pid,
            startTime: scenario === "foreign Gateway" ? launcherStart : startTime,
            ownerId: inspected && scenario === "rebound lock" ? "replacement" : "original",
            createdAt: "2026-09-08T00:00:00.000Z",
            port: 18792,
          };
        });
        vi.spyOn(serviceState, "readGatewayServiceState").mockResolvedValue({
          installed: true,
          loadState: { status: "loaded" },
          running: true,
          env: state.env,
          command: {
            programArguments: [
              process.execPath,
              path.join(root, "dist", "index.js"),
              "gateway",
              "run",
            ],
          },
          runtime: { status: "running", pid: process.ppid },
        });
        vi.spyOn(portInspection, "inspectPortUsage").mockResolvedValue({
          port: 18792,
          status: "busy",
          listeners: [],
          hints: ["Socket inspection tools are unavailable"],
        });
        if (scenario === "foreign child" || scenario === "unreadable parent") {
          vi.spyOn(processParents, "readProcessParentPidSync").mockReturnValue(
            scenario === "foreign child" ? process.ppid + 1 : null,
          );
        }
        const preflight = preflightUpdateCommandBackup({ opts: { run }, root, env: state.env });
        if (scenario === "owned child") {
          await expect(preflight).resolves.toBeUndefined();
        } else {
          await expect(preflight).rejects.toThrow("independent or unverified writer");
        }
        expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toEqual([
          expect.objectContaining({
            lease_id: lease,
            owner_pid: process.pid,
            owner_start_time: startTime,
          }),
        ]);
        await expect(fs.lstat(`${state.stateDir}.update-captures`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    } finally {
      releaseOpenClawAgentDatabaseLease(lease, { env: state.env });
    }
  });
});

it.each(["healthy", "readiness-missing", "wrong-version", "settlement-failed"] as const)(
  "retires only the settled, identity-verified capture: %s",
  async (scenario) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const temporary = state.path("coordinator");
      await fs.mkdir(temporary, { mode: 0o700 });
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const outputs: unknown[] = [];
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
        outputs.push(value);
      });
      const root = state.path("install");
      await fs.mkdir(root);
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
        env: state.env,
      };
      const opts = { json: true, run };
      const result: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        root,
        before: { version: "2026.9.3" },
        after: { version: "2026.9.4", buildId: "candidate-build" },
        steps: [],
        durationMs: 1,
      };
      let capturePath = "";
      const execution = withUpdateCommandTerminalResult(run, () =>
        withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          const backup = await createUpdateCommandBackup({ opts, root, env: state.env });
          capturePath = backup.directory;
          recordUpdateRunVerification(
            run.runId,
            {
              serviceRunning: true,
              versionMatch: true,
              runningVersion: scenario === "wrong-version" ? "2026.9.3" : "2026.9.4",
              runningBuildId: "candidate-build",
              readyz: scenario !== "readiness-missing",
              settled: true,
              channelsReady: true,
              pluginErrors: [],
            },
            { env: state.env },
          );
          recordUpdateRunStep(
            run.runId,
            {
              step: "gateway verification",
              status: "completed",
              endedAtMs: Date.now(),
            },
            { env: state.env },
          );
          deferUpdateCommandTerminalResult(run, async (failure) => {
            const settled = await resolveSettledUpdateCommandResult(
              { opts, root },
              result,
              failure,
            );
            return await publishUpdateCommandTerminalResult({ opts }, settled.result, {
              rolledBack: false,
            });
          });
          await completeUpdateCommandBackup(
            { opts, root, updateRecoveryBackup: backup },
            result,
            () => run.executorFence!.assertCurrent(),
          );
          // A published package and healthy Gateway cannot retire recovery while
          // the mutating invocation still owns its lifetime.
          expect((await fs.stat(capturePath)).isDirectory()).toBe(true);
          if (scenario === "settlement-failed") {
            const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
            try {
              db.exec(
                "CREATE TRIGGER refuse_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture release failure'); END",
              );
            } finally {
              db.close();
            }
          }
        }),
      );
      if (scenario === "settlement-failed") {
        await expect(execution).rejects.toThrow();
      } else {
        await execution;
      }
      const retained = await fs.stat(capturePath).then(
        () => true,
        () => false,
      );
      expect(retained).toBe(scenario !== "healthy");
      expect(outputs).toHaveLength(1);
      expect(getUpdateRun(run.runId, { env: state.env })?.status).toBe(
        scenario === "settlement-failed" ? "failed" : "succeeded",
      );
      if (retained) {
        expect(
          await fs.readFile(path.join(capturePath, "outcome.json"), "utf8").catch(() => null),
        ).toBeNull();
      }
    });
  },
);

it.each([false, true])(
  "captures only after physical writer quiescence (external writer=%s)",
  async (active) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        scenario: "minimal",
        env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" },
      },
      async (state) => {
        await state.writeConfig({ plugins: { enabled: false } });
        const temporary = state.path("coordinator");
        await fs.mkdir(temporary, { mode: 0o700 });
        vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
        const root = state.path("install");
        await fs.mkdir(root);
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
          env: state.env,
        };
        const anchor = acquireGatewayLifecycleCoordinator({
          databasePath: resolveOpenClawStateSqlitePath(state.env),
        });
        anchor.release();
        const writer = active
          ? tryAcquireExclusiveSqliteCoordinator(anchor.path, { busyTimeoutMs: 0 })
          : null;
        if (active) {
          expect(writer).not.toBeNull();
        }
        const before = await fs.readFile(state.configPath);
        try {
          await withUpdateCommandExecutor(run.runId, async (executor) => {
            run.executorFence = await executor.enter(root);
            const capture = createUpdateCommandBackup({ opts: { run }, root, env: state.env });
            if (active) {
              await expect(capture).rejects.toThrow(
                "another OpenClaw process owns gateway-lifecycle",
              );
              await expect(fs.lstat(`${state.stateDir}.update-captures`)).rejects.toMatchObject({
                code: "ENOENT",
              });
              expect(
                getUpdateRun(run.runId, { env: state.env })?.steps.some(
                  (step) => step.step === "update recovery backup",
                ),
              ).toBe(false);
            } else {
              const backup = await capture;
              expect((await fs.stat(backup.manifestPath)).isFile()).toBe(true);
            }
          });
          expect(await fs.readFile(state.configPath)).toEqual(before);
        } finally {
          writer?.release();
        }
      },
    );
  },
);
