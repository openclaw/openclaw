import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state-row.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { installationCountStateKey } from "./telemetry-installation-count.js";

const endpoint = "https://receiver.example.invalid/api/latest-version";
const day = 20688;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
function count(selectedEndpoint = endpoint, selectedDay = day) {
  return runOpenClawStateWorkerOperation(captureOpenClawStateWorkerContext(), (scope) =>
    scope.execute({
      type: "telemetry.claimInstallationCount",
      input: { endpoint: selectedEndpoint, day: selectedDay },
    }),
  );
}
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "installation-count-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("atomically claims one attempt, preserves it across worker restart, and does not rewrite same-day state", async () => {
  const claims = await Promise.all(Array.from({ length: 8 }, () => count()));
  expect(claims.filter((value) => value === "1;20688;31")).toHaveLength(1);
  expect(claims.filter((value) => value === null)).toHaveLength(7);
  const key = installationCountStateKey(endpoint);
  const row = () => readConfigMachineStateRowInDatabase(openOpenClawStateDatabase().db, key);
  const before = row();
  await closeOpenClawStateDatabaseAsync();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-23T18:00:00Z"));
  expect(await count()).toBeNull();
  expect(row()).toEqual(before);
  expect(await count(endpoint, day + 2)).toBe("1;20690;2");
  expect(readConfigMachineState(key)).toBe(20690);
});

it("scopes durable claims by endpoint rather than inventing an installation identifier", async () => {
  expect(await count()).toBe("1;20688;31");
  expect(await count(endpoint + "?other=1")).toBe("1;20688;31");
  expect(await count()).toBeNull();
});

it.each([null, "20687", -1, 20687.5, 20689, { lastDay: 20687 }])(
  "fails closed for invalid or future stored day %j without repairing it",
  async (value) => {
    const key = installationCountStateKey(endpoint);
    writeConfigMachineState(key, value);
    expect(await count()).toBeNull();
    expect(readConfigMachineState(key)).toEqual(value);
  },
);
