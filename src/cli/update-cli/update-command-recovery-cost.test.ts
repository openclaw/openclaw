import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import { waitForUpdateCandidateReadiness } from "../../infra/update-candidate-canary-readiness.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const temporary = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const root = temporary.make("updater-recovery-cost-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const run = createUpdateRun(
    { runId: "00000000-0000-4000-8000-000000000001", trigger: "cli" },
    { env },
  );
  await closeOpenClawStateDatabaseAsync();
  const database = resolveOpenClawStateSqlitePath(env);
  const opts: UpdateCommandOptions = { run: { runId: run.runId, env } };
  const guard = createUpdateCommandExecutionGuards(opts, root);
  const readiness = () =>
    waitForUpdateCandidateReadiness({
      port: 18789,
      workDeadline: Date.now() + 10_000,
      started: Date.now(),
      processExitSignal: new AbortController().signal,
      assertCurrent: guard.assertCurrent,
      hasExited: () => false,
      getExitReason: () => undefined,
      startupProgress: new Map(),
      onWarning: () => {
        throw new Error("Unexpected startup warning");
      },
      onEndpoint: () => {},
      capture: () => {},
      env,
      stateDir: root,
    });
  return { root, env, run, database, readiness };
}

it("avoids redundant recovery snapshots while readiness waits without warnings", async () => {
  const f = await fixture();
  vi.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  const digest = () => createHash("sha256").update(fs.readFileSync(f.database)).digest("hex");
  const before = digest();
  let polls = 0;
  const fetch = vi.fn(async () => {
    polls++;
    return polls <= 2
      ? Response.json({ status: "starting" }, { status: 503 })
      : Response.json({ status: "started", ready: true });
  });
  vi.stubGlobal("fetch", fetch);
  const snapshot = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  expect(await f.readiness()).toBeUndefined();
  expect(digest()).toBe(before);
  expect(fetch).toHaveBeenCalledTimes(4);
  // Fresh checks still bracket each probe; an absent warning adds no I/O.
  expect(snapshot.mock.calls.length).toBeLessThanOrEqual(8);
});

it("refuses recovery committed while the readiness probe is awaiting its reply", async () => {
  const f = await fixture();
  const fetch = vi.fn(async () => {
    const from = {
      root: path.join(f.root, "previous"),
      nodePath: process.execPath,
      version: "1.0.0",
      buildId: "previous-build",
    };
    createRetainedUpdateRecovery(
      {
        runId: f.run.runId,
        from,
        to: { ...from, root: path.join(f.root, "candidate"), version: "2.0.0" },
      },
      { env: f.env },
    );
    await closeOpenClawStateDatabaseAsync();
    return Response.json({ status: "started", ready: true });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(f.readiness()).rejects.toBeInstanceOf(UpdateRecoveryRequiredError);
  expect(fetch).toHaveBeenCalledOnce();
});
