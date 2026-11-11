import fs from "node:fs";
import * as timers from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../../test/helpers/file-snapshots.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import { waitForUpdateCandidateReadiness } from "../../infra/update-candidate-canary-readiness.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import { withArtifactPreservingStateReads } from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const temporary = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

async function fixture() {
  const root = temporary.make("updater-recovery-cost-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const database = resolveOpenClawStateSqlitePath(env);
  const guard = createUpdateCommandExecutionGuards({ run: { runId: run.runId, env } }, root);
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
  return { root, env, run, database, guard, readiness };
}

it("avoids redundant recovery snapshots while readiness waits without warnings", async () => {
  const f = await fixture();
  vi.spyOn(timers, "setTimeout").mockResolvedValue(undefined);
  const before = fs.readFileSync(f.database);
  let polls = 0;
  const fetch = vi.fn(async () => {
    polls++;
    return polls <= 2
      ? Response.json({ status: "starting" }, { status: 503 })
      : Response.json({ status: "started", ready: true });
  });
  vi.stubGlobal("fetch", fetch);
  const snapshot = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  f.guard.assertCurrent();
  expect(snapshot).not.toHaveBeenCalled();
  expect(await f.readiness()).toBeUndefined();
  expectBytesEqual(fs.readFileSync(f.database), before, "readiness database");
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(snapshot).not.toHaveBeenCalled();
  withArtifactPreservingStateReads(() => f.guard.assertCurrent());
  expect(snapshot).toHaveBeenCalledOnce();
  expectBytesEqual(fs.readFileSync(f.database), before, "artifact-preserving database");
});

it("refuses recovery committed while the readiness probe is awaiting its reply", async () => {
  const f = await fixture();
  const fetch = vi.fn(async () => {
    const runtime = { root: f.root, nodePath: process.execPath, version: "1.0.0", buildId: null };
    createRetainedUpdateRecovery(
      { runId: f.run.runId, from: runtime, to: runtime },
      { env: f.env },
    );
    await closeOpenClawStateDatabaseAsync();
    return Response.json({ status: "started", ready: true });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(f.readiness()).rejects.toBeInstanceOf(UpdateRecoveryRequiredError);
  expect(fetch).toHaveBeenCalledOnce();
});
