import { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveCronJobsStorePathFromConfigAsync,
  resolveCronStoreSelectionAsync,
  resolveDefaultCronStorePath,
} from "./store/paths.js";

it("prepares the current cron partition through the worker after each committed change", async () => {
  await withOpenClawTestState({ label: "cron-path-worker" }, async (state) => {
    const first = state.statePath("first", "jobs.json");
    const second = state.statePath("second", "jobs.json");
    await writeConfigMachineStateAsync("cron.store", first, { env: state.env });
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(await resolveCronJobsStorePathFromConfigAsync({}, state.env)).toBe(first);
      await writeConfigMachineStateAsync("cron.store", second, { env: state.env });
      expect(await resolveCronJobsStorePathFromConfigAsync({}, state.env)).toBe(second);
      expect(observation.queries.filter((sql) => sql.includes('"config_machine_state"'))).toEqual(
        [],
      );
    } finally {
      observation.restore();
    }
  });
});

it("keeps inspection partition selections separate from the live admission cache", async () => {
  await withOpenClawTestState({ label: "cron-selection-report-cache" }, async (state) => {
    const options = { env: state.env };
    writeConfigMachineState("cron.defaultStoreKey", "report-a", options);
    const context = captureOpenClawStateWorkerContext(options);
    const storePath = resolveDefaultCronStorePath(state.env);
    const read = () => resolveCronStoreSelectionAsync(storePath, state.env, context);
    const inspect = () =>
      withArtifactPreservingStateReads(() => withOpenClawStateDatabaseReadSnapshot(read, options), {
        agentDatabases: true,
      });

    expect(await inspect()).toMatchObject({ status: "ready", storeKey: "report-a" });
    writeConfigMachineState("cron.defaultStoreKey", "live-b", options);
    expect.soft(await read()).toMatchObject({ status: "ready", storeKey: "live-b" });
    writeConfigMachineState("cron.defaultStoreKey", "report-c", options);
    expect(await inspect()).toMatchObject({ status: "ready", storeKey: "report-c" });
  });
});
