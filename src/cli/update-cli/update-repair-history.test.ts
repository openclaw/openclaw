// Register shared mocks before importing the production CLI graph.
import "./update-repair.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";
import { noteStaleUpdateRuns } from "../../commands/doctor-update-run.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { isAcknowledgedAbandonedUpdateRun } from "../../infra/update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateRepairCommand } from "./update-repair-command.js";

const { createRepairState, mocks, pluginResult } = await import("./update-repair.test-support.js");

vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  confirmGatewayReachable: async () => ({ reachable: false }),
  waitForGatewayHttpReadiness: async () => ({ healthz: 503, readyz: 503 }),
}));
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createRepairState("repair-history");
  writeJsonFile(state.path("package.json"), { version: "1.0.0" });
  const control = state.path("control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

function seedHistory(ageMs: number, reason = "abandoned") {
  using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now() - ageMs);
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
  recordUpdateRunStep(run.runId, {
    step: "preflight",
    status: "failed",
    detail: "Original failure",
  });
  return finishUpdateRun(run.runId, { status: "failed", reason });
}
const seedPair = () => [seedHistory(4 * ABANDONED_UPDATE_RUN_MS), seedHistory(60_000)] as const;
function jsonResult() {
  return vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
}
async function repair() {
  await updateRepairCommand({ json: true, yes: true, timeout: "15", deferCompletionCache: true });
}
async function abandonedWarnings() {
  const notes = vi.mocked(note);
  notes.mockClear();
  await noteStaleUpdateRuns({ migrateState: false });
  return notes.mock.calls.flatMap(([message]) =>
    typeof message === "string" && message.includes("remains abandoned") ? [message] : [],
  );
}

it("acknowledges captured history behind 99 newer successful updates", async () => {
  const outside = seedHistory(10 * ABANDONED_UPDATE_RUN_MS);
  const previous = seedHistory(9 * ABANDONED_UPDATE_RUN_MS);
  for (let index = 0; index < 99; index++) {
    finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, { status: "succeeded" });
  }
  expect(listUpdateRuns({ limit: 100 }).at(-1)?.runId).toBe(previous.runId);
  expect(await abandonedWarnings()).toEqual([expect.stringContaining(previous.runId)]);
  await repair();
  expect(mocks.doctor).toHaveBeenCalledOnce();
  expect(mocks.plugins).toHaveBeenCalledOnce();
  const repaired = getUpdateRun(previous.runId)!;
  expect(isAcknowledgedAbandonedUpdateRun(repaired)).toBe(true);
  expect(repaired).toMatchObject({
    ...previous,
    updatedAtMs: expect.any(Number),
    steps: expect.arrayContaining(previous.steps),
  });
  expect(jsonResult()).toMatchObject({ status: "ok", reconciledRuns: [previous.runId] });
  expect(getUpdateRun(outside.runId)).toEqual(outside);
  expect(await abandonedWarnings()).toEqual([]);
  await repair();
  expect(getUpdateRun(previous.runId)).toEqual(repaired);
  expect(mocks.doctor).toHaveBeenCalledTimes(2);
});

it.each(["ok", "warning"] as const)(
  "acknowledges multiple rows only after %s convergence, excluding a newly admitted row",
  async (status) => {
    const [old, recent] = seedPair();
    const unrelated = seedHistory(30_000, "doctor-failed");
    let admitted: ReturnType<typeof seedHistory> | undefined;
    mocks.plugins.mockImplementationOnce(async () => {
      expect(getUpdateRun(old.runId)).toEqual(old);
      expect(getUpdateRun(recent.runId)).toEqual(recent);
      admitted = seedHistory(0);
      return { ...pluginResult, status };
    });
    await repair();
    for (const run of [old, recent]) {
      expect(isAcknowledgedAbandonedUpdateRun(getUpdateRun(run.runId)!)).toBe(true);
    }
    expect(getUpdateRun(unrelated.runId)).toEqual(unrelated);
    expect(getUpdateRun(admitted!.runId)).toEqual(admitted);
    expect(jsonResult()).toMatchObject({ status, reconciledRuns: [recent.runId, old.runId] });
    expect(await abandonedWarnings()).toEqual([expect.stringContaining(admitted!.runId)]);
  },
);

it.each([
  { phase: "doctor", setup: () => mocks.doctor.mockRejectedValueOnce(new Error("failed")) },
  {
    phase: "convergence",
    setup: () => mocks.convergence.mockRejectedValueOnce(new Error("failed")),
  },
  {
    phase: "error",
    setup: () => mocks.plugins.mockResolvedValueOnce({ ...pluginResult, status: "error" }),
  },
  {
    phase: "retained recovery",
    setup: () =>
      fs.mkdir(
        path.join(path.dirname(resolveOpenClawStateSqlitePath()), ".openclaw-restore-retained"),
      ),
  },
])("preserves history when repair fails in $phase", async ({ phase, setup }) => {
  const [old, recent] = seedPair();
  await setup();
  await expect(repair()).rejects.toThrow(
    phase === "retained recovery" ? "full-state recovery is deferred" : undefined,
  );
  if (phase === "retained recovery") {
    expect(mocks.doctor).not.toHaveBeenCalled();
  }
  expect(getUpdateRun(old.runId)).toEqual(old);
  expect(getUpdateRun(recent.runId)).toEqual(recent);
  if (phase !== "retained recovery") {
    expect(await abandonedWarnings()).toHaveLength(2);
  }
});

it("acknowledges historical rows while continuing its live owning update", async () => {
  const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
  const driver = readUpdateRunDriver();
  expect(driver).toBeDefined();
  const owner = createUpdateRun({ trigger: "cli", origin: { driver } });
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", owner.runId);

  await repair();

  expect(isAcknowledgedAbandonedUpdateRun(getUpdateRun(old.runId)!)).toBe(true);
  expect(getUpdateRun(owner.runId)?.status).toBe("running");
  expect(jsonResult()).toMatchObject({ status: "ok", reconciledRuns: [old.runId] });
  expect(await abandonedWarnings()).toEqual([]);
});

it("does not acknowledge terminal history if a captured active run remains unresolved", async () => {
  const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * ABANDONED_UPDATE_RUN_MS);
  const active = createUpdateRun({ trigger: "cli" });
  recordUpdateRunPhase(active.runId, "verifying");
  clock.mockRestore();
  mocks.plugins.mockImplementationOnce(async () => {
    recordUpdateRunStep(active.runId, {
      step: "build",
      status: "in_progress",
      startedAtMs: Date.now(),
    });
    return pluginResult;
  });
  await expect(repair()).rejects.toThrow("did not assume the update resumed");
  expect(getUpdateRun(old.runId)).toEqual(old);
  expect(getUpdateRun(active.runId)?.status).toBe("running");
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});
