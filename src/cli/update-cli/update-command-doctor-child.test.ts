import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runUpdateDoctorProcess } from "./update-command-doctor-child.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
afterAll(() => closeOpenClawStateDatabaseAsync());

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
