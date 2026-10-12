import { expect, it } from "vitest";
import { writeConfigMachineStateAsync } from "../../state/config-machine-state-write-async.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCronJobsStorePathAsync } from "./paths.js";

it("selects the current cron partition after in-process machine-state writes", async () => {
  await withOpenClawTestState({ label: "cron-partition-async" }, async (state) => {
    const database = { env: state.env };
    const first = state.path("first-jobs.json");
    const second = state.path("second-jobs.json");
    await writeConfigMachineStateAsync("cron.store", first, database);
    expect(await resolveCronJobsStorePathAsync(undefined, state.env)).toBe(first);
    await writeConfigMachineStateAsync("cron.store", second, database);
    expect(await resolveCronJobsStorePathAsync(undefined, state.env)).toBe(second);
    expect(await resolveCronJobsStorePathAsync(first, state.env)).toBe(first);
  });
});
