import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { getUpdateRunAsync, listUpdateRunsAsync } from "../infra/update-run-reader.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import * as updateWrites from "../infra/update-run-write.async.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { node, repository, root } from "./prepare.test-support.js";
import { prepareUpdate } from "./run.js";
import { readTrial } from "./store.js";

it("records one failed terminal run when preparation lock acquisition throws", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  try {
    openOpenClawStateDatabase({ env: process.env });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    vi.spyOn(fs, "link").mockRejectedValue(new Error("preparation lock failed"));
    expect(
      await prepareUpdate({
        runId: run.runId,
        runningRoot: root,
        runningVersion: VERSION,
        channel: "dev",
      }),
    ).toMatchObject({ status: "failed" });
    expect(await listUpdateRunsAsync()).toEqual([
      expect.objectContaining({ runId: run.runId, status: "failed", phase: "finished" }),
    ]);
    expect(await readTrial()).toBeNull();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});

it("does not publish a trial when preparation outcome bookkeeping throws", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const { checkout } = await repository(false, ">=1", true);
  const recordPhase = updateWrites.recordUpdateRunPhaseAsync;
  vi.spyOn(updateWrites, "recordUpdateRunPhaseAsync").mockImplementation((id, phase, ...rest) =>
    phase === "activating"
      ? Promise.reject(new Error("preparation outcome bookkeeping failed"))
      : recordPhase(id, phase, ...rest),
  );
  try {
    openOpenClawStateDatabase({ env: process.env });
    const run = await createUpdateRunAsync({ trigger: "cli" });
    expect(
      await prepareUpdate({
        runId: run.runId,
        runningRoot: checkout,
        runningVersion: VERSION,
        channel: "dev",
        node,
      }),
    ).toMatchObject({ status: "failed" });
    expect(await getUpdateRunAsync(run.runId)).toMatchObject({
      status: "failed",
      phase: "finished",
    });
    expect(await readTrial()).toBeNull();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  }
});
