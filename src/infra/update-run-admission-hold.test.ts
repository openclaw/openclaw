import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { captureUpdateRunRedactionFacts } from "./update-run-codec.js";
import { executeUpdateRunCommand } from "./update-run-dispatch.worker.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { openUpdateRunWriter } from "./update-run-mutation.worker.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let env: { OPENCLAW_STATE_DIR: string };
beforeAll(() => {
  env = { OPENCLAW_STATE_DIR: dirs.make("update-admission-hold-") };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.each([false, true])(
  "releases the writer before retrying delayed commit admission (revoked=%s)",
  async (revoke) => {
    const options = { env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    await closeOpenClawStateDatabaseAsync();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const writer = openUpdateRunWriter(options);
    const competitor = new DatabaseSync(databasePath);
    competitor.exec("PRAGMA busy_timeout = 0");
    let revoked = false;
    const admission = createSqliteWorkerWriteAdmission(() => {
      if (revoked) {
        throw new Error("update custody revoked");
      }
    }, [databasePath])({ settled: Promise.resolve({ kind: "completed" }) }).admission;
    let now = process.hrtime.bigint();
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    let stage: string | undefined;
    let delayed = false;
    const requestAdmission = workerAdmission.requestSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission").mockImplementation(
      (request) => {
        stage = request.stage;
        try {
          return requestAdmission(request);
        } finally {
          stage = undefined;
        }
      },
    );
    let competingWrite = false;
    vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
      if (stage === "commit" && !delayed) {
        delayed = true;
        // Delay the host decision, not SQL; no wall-clock wait is needed.
        expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
        now += 20_537_000_000n;
        if (timeout === undefined) {
          admission.service();
        }
        return "timed-out";
      }
      if (stage === "transaction" && delayed && !competingWrite) {
        competitor.exec("BEGIN IMMEDIATE");
        competitor
          .prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?")
          .run(JSON.stringify({ sessionKey: "competing-writer" }), run.runId);
        competitor.exec("COMMIT");
        competingWrite = true;
        revoked = revoke;
      }
      admission.service();
      return "ok";
    });
    try {
      const execute = () =>
        runWithSqliteWorkerStateContext({ environment: env }, () =>
          workerAdmission.withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            executeUpdateRunCommand(
              {
                type: "updateRuns.recordPhase",
                input: {
                  runId: run.runId,
                  redactionFacts: captureUpdateRunRedactionFacts(env),
                  phase: "validating",
                  patch: {},
                },
              },
              { path: databasePath, env },
              () => writer,
            ),
          ),
        );
      if (revoke) {
        expect(execute).toThrow("admission was refused");
      } else {
        expect(execute()).toMatchObject({ kind: "recorded", record: { phase: "validating" } });
      }
      expect(competingWrite).toBe(true);
      expect(getUpdateRun(run.runId, options)).toMatchObject({
        phase: revoke ? "requested" : "validating",
        origin: { sessionKey: "competing-writer" },
      });
    } finally {
      admission.finish();
      competitor.close();
      writer.close();
    }
  },
);
