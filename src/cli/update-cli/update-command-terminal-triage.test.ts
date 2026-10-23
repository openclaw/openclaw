import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { withDatabase } from "../../infra/package-update-activation-fixtures.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../infra/update-managed-service-handoff-runtime.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor as withExecutor } from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { UpdateCommandRecoveryPendingError as RecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UpdateCommandFailure as UpdateFailure,
  UpdateCommandPendingRecoveryFailure as PendingRecoveryFailure,
} from "./update-command-result.js";
import {
  deferUpdateCommandTerminalResult as deferResult,
  resolveSettledUpdateCommandResult as settleResult,
  withUpdateCommandTerminalResult as withTerminal,
} from "./update-command-terminal.js";
import { publishUpdateCommandTerminalResultForTest as publishResult } from "./update-command-terminal.test-support.js";
import { withUpdateFailureTriage as withTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind as withRecovery } from "./update-command-unwind.js";

const fixture = useExecutorFixture("update-terminal-triage-", { restoreEnv: true });

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { name: "revoked", revoked: true, releaseDenied: false, json: true },
  { name: "authorized-failure", revoked: false, releaseDenied: false, json: true },
  { name: "release-denied", revoked: false, releaseDenied: true, json: false },
])("preserves settled managed failure disposition: $name", async (trial) => {
  const { root, control: temporary } = fixture();
  const diagnosticDir = path.join(root, "diagnostics");
  await fs.mkdir(diagnosticDir, { mode: 0o700 });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "state", "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
  const metadata = path.join(root, "handoff.json");
  vi.stubEnv(CONTROL_PLANE_UPDATE_SENTINEL_META_ENV, metadata);
  const env = { ...process.env };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const owner = randomUUID();
  const artifact = path.join(diagnosticDir, "update-failure.json");
  const previous = '{"retained":"original diagnostic"}\n';
  await fs.writeFile(artifact, previous, { mode: 0o600 });
  const priorStat = await fs.stat(artifact);
  await fs.writeFile(
    metadata,
    JSON.stringify({
      version: 1,
      meta: { runId: run.runId, handoffId: owner, root, triageContextPath: artifact },
    }),
  );
  const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
  const existingIdentity = createManagedHandoffLeaseDatabase(databasePath)(true, () =>
    captureManagedUpdateLeaseDatabaseIdentity(databasePath),
  );
  stageManagedHandoffRuntime(root);
  const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  const leaseOptions = {
    databasePath,
    serviceManagerEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    existingIdentity,
  };
  const helperCode = `
      const {createManagedHandoffLeaseStore}=require(${JSON.stringify(runtimeEntry)});
      const store=createManagedHandoffLeaseStore(${JSON.stringify(leaseOptions)});
      const acquired=store.acquire(${JSON.stringify(root)},${JSON.stringify(owner)},{kind:"update"});
      if(acquired.kind!=="acquired")throw new Error("helper admission failed");
      if(!store.bind(acquired.lease,${process.pid}))throw new Error("helper assignment failed");
      process.once("message",()=>{
        const current=store.read(${JSON.stringify(root)});
        const local=current.kind==="current"&&store.bind(current.lease,process.pid);
        if(!local||!store.release(local))throw new Error("helper release failed");
        process.disconnect();
      });
      process.send("assigned");
      `;
  // The helper really acquires and assigns the lease; no borrowed-owner method is mocked.
  const helper = trial.releaseDenied
    ? undefined
    : spawn(process.execPath, ["-e", helperCode], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
  const exited = helper ? once(helper, "exit") : undefined;
  let stderr = "";
  helper?.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  try {
    if (helper && exited) {
      const [ready] = await awaitGateBeforeSettlement(
        once(helper, "message"),
        exited,
        "helper exited before assignment",
      );
      expect(ready).toBe("assigned");
    }
    const store = createManagedHandoffLeaseStore();
    const assigned = store.read(root);
    if (helper) {
      expect(assigned).toMatchObject({
        kind: "current",
        lease: { owner, helper: { pid: helper.pid }, executor: { pid: process.pid } },
      });
    }
    const reportPath = path.join(root, "state", "update-reports", `${run.runId}.md`);
    let savedAtPublication: string | undefined;
    const captureReport = () => {
      savedAtPublication ??= readFileSync(reportPath, "utf8");
    };
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(captureReport);
    const human = vi.spyOn(defaultRuntime, "log").mockImplementation(captureReport);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    // These spies call through to the real filesystem, including atomic temp creation.
    const opened = vi.spyOn(fs, "open");
    const renamed = vi.spyOn(fs, "rename");
    const result = resultFixture(undefined, {
      status: "error",
      root,
      reason: "global-install-failed",
      durationMs: 1,
    });
    const opts = { json: trial.json, yes: true, run };
    const target = { root, env };
    let statusAtPublication: string | undefined;
    let pendingAtPublication = false;
    let releasePendingAtPublication = false;
    let failureCauses: string[] = [];
    const exit = await withTriage(opts, target, () =>
      withTerminal((registerRun) => {
        registerRun(run);
        return withExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          await withRecovery(opts, { triageTarget: target }, async () => {
            expect(
              deferResult(run, async (failure) => {
                statusAtPublication = getUpdateRun(run.runId, { env })?.status;
                pendingAtPublication = failure instanceof PendingRecoveryFailure;
                releasePendingAtPublication = failure instanceof RecoveryPendingError;
                failureCauses = collectNestedErrorCandidates(failure)
                  .filter((candidate): candidate is Error => candidate instanceof Error)
                  .map((candidate) => candidate.message);
                const settled = await settleResult({ opts, root }, result, failure);
                return publishResult({ opts }, settled.result, { rolledBack: false });
              }),
            ).toBe(true);
            run.executorFence!.assertCurrent();
            if (trial.revoked) {
              withDatabase(databasePath, (db) =>
                db
                  .prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?")
                  .run("replacement-owner", root),
              );
            }
            if (trial.releaseDenied) {
              // Only final lease deletion is denied; admission and inner unwind stay real.
              withDatabase(databasePath, (db) =>
                db.exec(
                  "CREATE TRIGGER deny_terminal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture final lease delete denied'); END",
                ),
              );
            }
            throw new UpdateFailure(result, 7, "fixture package failure");
          });
        });
      }),
    ).catch((error: unknown) => error);
    const after = await fs.readFile(artifact, "utf8");
    const afterStat = await fs.stat(artifact);
    const artifactOpens = opened.mock.calls.filter(
      ([file, flags]) => path.dirname(String(file)) === diagnosticDir && flags === "wx",
    ).length;
    const artifactRenames = renamed.mock.calls.filter(
      ([, destination]) => String(destination) === artifact,
    ).length;
    const recorded = getUpdateRun(run.runId, { env });
    expect(exit).toBeInstanceOf(ExitError);
    expect(savedAtPublication).toContain("OpenClaw update failed");
    const unsettled = trial.revoked || trial.releaseDenied;
    expect(exit).toMatchObject({ code: unsettled ? 1 : 7 });
    expect(statusAtPublication).toBe("running");
    expect(pendingAtPublication).toBe(trial.revoked);
    expect(releasePendingAtPublication).toBe(trial.releaseDenied);
    if (trial.releaseDenied) {
      expect(failureCauses).toContain("fixture package failure");
      expect(failureCauses.join("\n")).toContain("fixture final lease delete denied");
    }
    if (trial.json) {
      expect(output).toHaveBeenCalledOnce();
      expect(output.mock.calls[0]?.[0]).toMatchObject({
        status: "error",
        reportPath,
        reason: unsettled ? "update-executor-settlement-failed" : "global-install-failed",
      });
    } else {
      expect(output).not.toHaveBeenCalled();
      expect(recorded).toBeDefined();
      const report = renderUpdateRunReport(recorded!);
      expect(
        human.mock.calls.filter(([line]) => String(line).includes(report.headline)),
      ).toHaveLength(1);
    }
    expect(recorded?.status).toBe("failed");
    // Direct release denial retains the local lease; borrowing retains the helper's lease.
    expect(store.read(root)).toMatchObject({
      kind: "current",
      lease: trial.releaseDenied
        ? { helper: { pid: process.pid }, executor: { pid: process.pid } }
        : { owner: trial.revoked ? "replacement-owner" : owner },
    });
    expect(artifactOpens).toBe(unsettled ? 0 : 1);
    expect(artifactRenames).toBe(unsettled ? 0 : 1);
    if (unsettled) {
      expect(after).toBe(previous);
      expect(afterStat).toMatchObject({ ino: priorStat.ino, mtimeMs: priorStat.mtimeMs });
    } else {
      expect(JSON.parse(after)).toMatchObject({
        result: { status: "error", reason: result.reason },
      });
    }
  } finally {
    if (helper?.connected) {
      helper.send("release");
    }
    if (exited) {
      const [code] = await exited;
      expect(code, stderr).toBe(0);
    }
    if (trial.releaseDenied) {
      withDatabase(databasePath, (db) => db.exec("DROP TRIGGER IF EXISTS deny_terminal_release"));
      const store = createManagedHandoffLeaseStore();
      const retained = store.read(root);
      if (retained.kind === "current") {
        expect(store.release(retained.lease)).toBe(true);
      }
    }
  }
});
