import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../infra/errno.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "../../infra/update-managed-service-handoff-runtime-assets.js";
import { stageManagedHandoffRuntime } from "../../infra/update-managed-service-handoff-runtime.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("preserves the rollback result when recovery fails before terminal settlement", async () => {
  const root = await fs.realpath(dirs.make("update-terminal-rollback-"));
  const candidateRoot = path.join(root, "candidate");
  const previousRoot = path.join(root, "previous");
  const pendingResult: UpdateRunResult = {
    status: "ok",
    mode: "npm",
    root: candidateRoot,
    after: { version: "2026.9.4" },
    steps: [],
    durationMs: 1,
  };
  const rollbackResult: UpdateRunResult = {
    ...pendingResult,
    status: "error",
    root: previousRoot,
    after: { version: "2026.9.3" },
    reason: "update-state-rollback-failed",
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    steps: [
      {
        name: "global install rollback",
        command: "openclaw update",
        cwd: previousRoot,
        durationMs: 1,
        exitCode: 0,
      },
      {
        name: "update state rollback",
        command: "openclaw update",
        cwd: previousRoot,
        durationMs: 1,
        exitCode: 1,
        stderrTail: "State restore failed; retained recovery set requires repair.",
      },
    ],
  };
  const failure = new UpdateCommandPendingRecoveryFailure(rollbackResult);
  const settled = await resolveSettledUpdateCommandResult(
    {
      opts: {},
      root: candidateRoot,
      ownedManagedUpdateEnv: {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      },
    },
    pendingResult,
    failure,
  );

  expect(settled.settlementFailed).toBe(true);
  expect(settled.result).toMatchObject({
    status: "error",
    reason: "update-executor-settlement-failed",
    root: previousRoot,
    after: { version: "2026.9.3" },
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
  });
  expect(settled.result.steps).toEqual([
    ...rollbackResult.steps,
    expect.objectContaining({
      name: "update executor settlement",
      cwd: previousRoot,
      exitCode: 1,
    }),
  ]);
});

it.each([
  { name: "revoked-absent", revoked: true, existing: false },
  { name: "revoked-existing", revoked: true, existing: true },
  { name: "authorized-failure", revoked: false, existing: true },
])("preserves settled managed failure disposition: $name", async (trial) => {
  const root = await fs.realpath(dirs.make("update-terminal-triage-"));
  const temporary = path.join(root, "private-tmp");
  const diagnosticDir = path.join(root, "diagnostics");
  await fs.mkdir(temporary, { mode: 0o700 });
  await fs.mkdir(diagnosticDir, { mode: 0o700 });
  // Only choose disposable state. Executor admission, process identities, ledger,
  // publication, outer triage and the atomic diagnostic writer remain real.
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
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
  if (trial.existing) {
    await fs.writeFile(artifact, previous, { mode: 0o600 });
  }
  const priorStat = trial.existing ? await fs.stat(artifact) : undefined;
  await fs.writeFile(
    metadata,
    JSON.stringify({
      version: 1,
      meta: { runId: run.runId, handoffId: owner, root, triageContextPath: artifact },
    }),
  );
  stageManagedHandoffRuntime(root);
  const runtimeEntry = path.join(root, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
  const leaseOptions = {
    databasePath,
    serviceManagerEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  };
  // The helper really acquires and assigns the lease; no borrowed-owner method is mocked.
  const helper = spawn(
    process.execPath,
    [
      "-e",
      `
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
      `,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(helper, "exit");
  let stderr = "";
  helper.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  try {
    const ready = await Promise.race([
      once(helper, "message").then(([message]) => message),
      exited.then(() => {
        throw new Error(`helper exited before assignment: ${stderr}`);
      }),
    ]);
    expect(ready).toBe("assigned");
    const store = createManagedHandoffLeaseStore();
    const assigned = store.read(root);
    expect(assigned).toMatchObject({
      kind: "current",
      lease: { owner, helper: { pid: helper.pid }, executor: { pid: process.pid } },
    });
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    // These spies call through to the real filesystem, including atomic temp creation.
    const opened = vi.spyOn(fs, "open");
    const renamed = vi.spyOn(fs, "rename");
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      root,
      reason: "global-install-failed",
      steps: [],
      durationMs: 1,
    };
    const opts = { json: true, yes: true, run };
    const target = { root, env };
    let statusAtPublication: string | undefined;
    let pendingAtPublication = false;
    let exit: unknown;
    await withUpdateFailureTriage(opts, target, () =>
      withUpdateCommandTerminalResult(run, () =>
        withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          await withUpdateCommandRecoveryUnwind(opts, { triageTarget: target }, async () => {
            expect(
              deferUpdateCommandTerminalResult(run, async (failure) => {
                statusAtPublication = getUpdateRun(run.runId, { env })?.status;
                pendingAtPublication = failure instanceof UpdateCommandPendingRecoveryFailure;
                const settled = await resolveSettledUpdateCommandResult(
                  { opts, root },
                  result,
                  failure,
                );
                return publishUpdateCommandTerminalResult({ opts }, settled.result, {
                  rolledBack: false,
                });
              }),
            ).toBe(true);
            run.executorFence!.assertCurrent();
            if (trial.revoked) {
              const db = new DatabaseSync(databasePath);
              try {
                db.prepare(
                  "UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?",
                ).run("replacement-owner", root);
              } finally {
                db.close();
              }
            }
            throw new UpdateCommandFailure(result, 7, "fixture package failure");
          });
        }),
      ),
    ).catch((error: unknown) => {
      exit = error;
    });
    const after = await fs.readFile(artifact, "utf8").catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });
    const afterStat = after === null ? undefined : await fs.stat(artifact);
    const artifactOpens = opened.mock.calls.filter(
      ([file, flags]) => path.dirname(String(file)) === diagnosticDir && flags === "wx",
    ).length;
    const artifactRenames = renamed.mock.calls.filter(
      ([, destination]) => String(destination) === artifact,
    ).length;
    const recorded = getUpdateRun(run.runId, { env });
    const observation = {
      name: trial.name,
      statusAtPublication,
      pendingAtPublication,
      exitCode: exit instanceof ExitError ? exit.code : null,
      reports: output.mock.calls.map(([value]) => value),
      artifactBefore: trial.existing ? previous : null,
      artifactAfter: after,
      artifactOpens,
      artifactRenames,
      recorded,
      artifactIdentityUnchanged:
        priorStat && afterStat
          ? priorStat.ino === afterStat.ino && priorStat.mtimeMs === afterStat.mtimeMs
          : undefined,
      leaseAfter: store.read(root),
    };
    const evidence = process.env.OPENCLAW_TERMINAL_TRIAGE_PROOF_DIR;
    if (evidence) {
      await fs.mkdir(evidence, { recursive: true });
      await fs.writeFile(
        path.join(evidence, `${trial.name}.json`),
        JSON.stringify(observation, null, 2),
      );
    }
    expect(exit).toBeInstanceOf(ExitError);
    expect(observation.exitCode).toBe(trial.revoked ? 1 : 7);
    expect(statusAtPublication).toBe("running");
    expect(pendingAtPublication).toBe(trial.revoked);
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toMatchObject({
      status: "error",
      reason: trial.revoked ? "update-executor-settlement-failed" : "global-install-failed",
    });
    expect(recorded?.status).toBe("failed");
    // The borrowed invocation never releases the helper's lease, including after revocation.
    expect(observation.leaseAfter).toMatchObject({
      kind: "current",
      lease: { owner: trial.revoked ? "replacement-owner" : owner },
    });
    if (trial.revoked) {
      expect(artifactOpens).toBe(0);
      expect(artifactRenames).toBe(0);
      expect(after).toBe(trial.existing ? previous : null);
      if (trial.existing) {
        expect(observation.artifactIdentityUnchanged).toBe(true);
      }
    } else {
      expect(artifactOpens).toBe(1);
      expect(artifactRenames).toBe(1);
      expect(JSON.parse(after!)).toMatchObject({
        result: { status: "error", reason: result.reason },
      });
    }
  } finally {
    if (helper.connected) {
      helper.send("release");
    }
    const [code] = await exited;
    expect(code, stderr).toBe(0);
  }
});
