import { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { writeConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronJobsStorePathFromConfigAsync } from "./store/paths.js";

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
