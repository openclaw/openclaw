import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createUpdateRun,
  finishUpdateRun as finishLedgerRun,
  getUpdateRun,
} from "../infra/update-run-ledger.js";
import { defaultRuntime } from "../runtime.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { finishUpdateRun, recordUpdateRunDiagnostic } from "./daemon-cli.js";
import { printResult } from "./update-cli/progress.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const handoffFailure = { status: "failed", reason: "managed-service-handoff-failed" } as const;
const fail = (reason: string) => ({ status: "failed" as const, reason });

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function fixture() {
  const stateDir = tempDirs.make("openclaw-daemon-ledger-");
  const env = {
    HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
  };
  const options = { env };
  const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } }, options);
  const result = {
    status: "ok" as const,
    mode: "git" as const,
    steps: [],
    durationMs: 0,
    runId: run.runId,
  };
  const opts = { json: true, run: { runId: run.runId, env } };
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  return { stateDir, options, run, result, opts };
}

async function finishFromPublishedDriver(
  runId: string,
  outcome: { status: "failed"; reason: string },
  options: { env: NodeJS.ProcessEnv },
): Promise<void> {
  const entry = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.daemon);
  // Published managed drivers call this stable export without awaiting it.
  // Their child exits naturally after the finalizer settles the ledger.
  const result = await runCliProcessChild({
    nodeArgs: [
      ...resolveRuntimeWorkerArgv(entry).slice(0, -1),
      "--input-type=module",
      "-e",
      `
        const { finishUpdateRun } = await import(${JSON.stringify(entry.href)});
        finishUpdateRun(${JSON.stringify(runId)}, ${JSON.stringify(outcome)}, ${JSON.stringify(options)});
      `,
    ],
    nodeArgsPolicy: "caller",
    env: { ...process.env, ...options.env },
    timeoutMs: 15_000,
  });
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
}

it("exports the terminal-safe update diagnostic writer for installed-runtime finalization", async () => {
  const { options, run } = fixture();
  await finishUpdateRun(run.runId, fail("post-update-failed"), options);

  recordUpdateRunDiagnostic(
    run.runId,
    "Gateway availability is unverified after failed settlement.",
    options,
    "warning:gateway-availability",
  );

  const saved = getUpdateRun(run.runId, options);
  expect(saved).toMatchObject({ status: "failed", reason: "post-update-failed" });
  expect(saved?.steps).toContainEqual(
    expect.objectContaining({ step: "warning:gateway-availability", status: "completed" }),
  );
});

it.each(["published driver", "settled child"] as const)(
  "preserves terminal ledger authority after %s settlement",
  async (driver) => {
    const { options, run } = fixture();
    const reason =
      driver === "settled child" ? "candidate-validation-failed" : handoffFailure.reason;
    if (driver === "settled child") {
      finishLedgerRun(run.runId, fail(reason), options);
      await finishUpdateRun(run.runId, handoffFailure, options);
    } else {
      await finishFromPublishedDriver(run.runId, handoffFailure, options);
    }
    expect(getUpdateRun(run.runId, options)).toMatchObject({
      status: "failed",
      phase: "finished",
      reason,
      verification: {},
    });
  },
);

it("preserves a child-authored terminal verdict in JSON and the ledger", async () => {
  const { options, run, result, opts } = fixture();
  await finishUpdateRun(run.runId, fail("candidate-validation-failed"), options);
  await printResult({ ...result, status: "error", reason: "candidate-validation-failed" }, opts);
  expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
    expect.objectContaining({
      run: expect.objectContaining({ status: "failed", reason: "candidate-validation-failed" }),
    }),
  );
  await finishUpdateRun(run.runId, { status: "succeeded" }, options);
  expect(getUpdateRun(run.runId, options)?.status).toBe("failed");
});

it.each(["terminal", "captured"] as const)(
  "preserves %s terminal output authority after schema admission closes",
  async (kind) => {
    const { options, run, result, opts } = fixture();
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const captured = await finishUpdateRun(run.runId, fail("helper-first-failure"), options);
    expect(getUpdateRun(run.runId, options)?.status).toBe("failed");
    closeOpenClawStateDatabaseForTest();
    {
      using database = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    }
    expect(() => getUpdateRun(run.runId, options)).toThrow(/newer schema/);
    await printResult(
      result,
      opts,
      kind === "captured"
        ? { record: captured, nextAction: "Captured terminal recovery instructions." }
        : {},
    );
    if (kind === "captured") {
      expect(error).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({
          run: expect.objectContaining({ status: "failed", reason: "helper-first-failure" }),
        }),
      );
    } else {
      expect(error).toHaveBeenCalledWith(expect.stringContaining("history unavailable"));
      expect(vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0]).not.toHaveProperty("run");
    }
  },
);
