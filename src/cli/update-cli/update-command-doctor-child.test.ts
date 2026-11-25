import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestEntrypoint } from "../../infra/runtime-entrypoint.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
} from "../../infra/update-run-write.async.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateProgress } from "./progress.js";
import { runUpdateDoctorProcess } from "./update-command-doctor-child.js";
import { withUpdateStateReleasedAcrossRestart } from "./update-command-state-handoff.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
afterAll(() => closeOpenClawStateDatabaseAsync());
// Each case owns its state directory; no worker owner may carry into the next case.
afterEach(() => closeOpenClawStateDatabaseAsync());

it.each([0, 23])("readmits the baseEnv database after Doctor exits with %s", async (exitCode) => {
  const root = dirs.make("doctor-schema-handoff-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "doctor-state") };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const result = await runUpdateDoctorProcess(
    { runId: run.runId, root },
    [
      process.execPath,
      "-e",
      `const {DatabaseSync}=require('node:sqlite');
       const db=new DatabaseSync(process.argv[1]);
       db.exec(${JSON.stringify(`BEGIN IMMEDIATE; PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1}; UPDATE schema_meta SET schema_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1} WHERE meta_key='primary'; COMMIT;`)});
       db.close(); process.exitCode=${exitCode};`,
      resolveOpenClawStateSqlitePath(env),
    ],
    {
      baseEnv: env,
      env: { [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: path.join(root, "doctor-result.json") },
      timeoutMs: 5_000,
    },
  );
  expect(result.code, result.stderr).toBe(exitCode);
  expect(() => getUpdateRun(run.runId, { env })).toThrow(/newer schema version/);
});

it("keeps live progress observation from refusing the Doctor's exclusive state custody", async () => {
  const root = dirs.make("doctor-progress-custody-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "doctor-state") };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const presentation = createUpdateProgress(true, { runId: run.runId, env });
  try {
    // The first committed phase proves the parent's reader is open before the child starts.
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Phase: requested"), {
      timeout: 10_000,
    });
    const result = await runUpdateDoctorProcess(
      { runId: run.runId, root },
      [
        process.execPath,
        "-e",
        `const {DatabaseSync}=require('node:sqlite');
         const db=new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;");
         db.close();`,
        resolveOpenClawStateSqlitePath(env),
      ],
      {
        baseEnv: env,
        env: {
          [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: path.join(root, "doctor-result.json"),
        },
        timeoutMs: 5_000,
      },
    );
    expect(result.code, result.stderr).toBe(0);
  } finally {
    presentation.dispose();
    log.mockRestore();
  }
});

// The Gateway restart is the other point where another process may replace shared state.
const successorUrl = resolveRuntimeWorkerUrl(
  createTestEntrypoint(
    import.meta.url,
    "cli/update-cli",
  )("update-command-state-handoff.process.test-support"),
);

async function startUpdate() {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-state-handoff-") };
  const options = { env };
  const { runId } = await createUpdateRunAsync({ trigger: "cli" }, options);
  // The installed updater writes through its retained shared-state worker owner.
  await recordUpdateRunPhaseAsync(runId, "restarting", {}, options);
  return {
    runId,
    env,
    options,
    live: path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
  };
}

/** Another process replaces the file the way a successor's boot upgrade does. */
async function swapInSuccessor(live: string): Promise<void> {
  const child = fork(successorUrl, [live], {
    // fork() supplies the entry path itself; keep only the loader arguments.
    execArgv: resolveRuntimeWorkerArgv(successorUrl).slice(0, -1),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code, output).toBe(0);
  expect(fs.existsSync(`${live}.pre-successor`)).toBe(true);
}

function readRun(file: string, runId: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // SAFETY: the statement fixes the selected column names and their STRICT types.
    const row = db
      .prepare("SELECT status, phase, steps_json FROM update_runs WHERE run_id = ?")
      .get(runId) as { status: string; phase: string; steps_json: string } | undefined;
    // SAFETY: steps_json is the ledger's own encoding of an array of step records.
    const steps = row ? (JSON.parse(row.steps_json) as Array<{ step: string }>) : [];
    return row && { status: row.status, phase: row.phase, steps: steps.map(({ step }) => step) };
  } finally {
    db.close();
  }
}

function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    messages.push(cause.message);
  }
  return messages;
}

it("keeps refusing an owner that still pins a replaced state database", async () => {
  const { runId, options, live } = await startUpdate();
  await swapInSuccessor(live);

  const refusal = await recordUpdateRunStepAsync(
    runId,
    { step: "post-update verification", status: "in_progress" },
    options,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(causeMessages(refusal)).toContain("Existing-state database generation changed.");
  expect(readRun(live, runId)?.steps).not.toContain("post-update verification");
});

it("records the remaining update steps in the successor's state database", async () => {
  const { runId, env, options, live } = await startUpdate();
  await withUpdateStateReleasedAcrossRestart({ runId, env }, async () => {
    // The restart records progress while the new build still boots.
    await recordUpdateRunPhaseAsync(runId, "verifying", {}, options);
    await swapInSuccessor(live);
    // Readiness receipts use one-shot ledger writes, which follow the current file.
    recordUpdateRunStep(runId, { step: "gateway verification", status: "completed" }, options);
  });

  await recordUpdateRunStepAsync(
    runId,
    { step: "post-update verification", status: "completed" },
    options,
  );
  await finishUpdateRunAsync(runId, { status: "succeeded" }, options);

  // History written before the swap was carried into the successor's file.
  expect(readRun(live, runId)).toMatchObject({
    status: "succeeded",
    phase: "finished",
    steps: expect.arrayContaining([
      "restarting",
      "verifying",
      "gateway verification",
      "post-update verification",
    ]),
  });
  // The previous generation never receives the steps recorded after the successor serves.
  const previous = readRun(`${live}.pre-successor`, runId);
  expect(previous).toMatchObject({ status: "running" });
  expect(previous?.steps).not.toContain("post-update verification");
});

it("reopens the current file when the restart fails", async () => {
  const { runId, env, options, live } = await startUpdate();
  const failure = new Error("Gateway readiness timed out");

  await expect(
    withUpdateStateReleasedAcrossRestart({ runId, env }, async () => {
      await recordUpdateRunPhaseAsync(runId, "verifying", {}, options);
      await swapInSuccessor(live);
      throw failure;
    }),
  ).rejects.toBe(failure);

  // Failure recovery still records its outcome in the successor's file.
  await finishUpdateRunAsync(runId, { status: "failed", reason: "restart-unhealthy" }, options);
  expect(readRun(live, runId)).toMatchObject({ status: "failed", phase: "finished" });
});
