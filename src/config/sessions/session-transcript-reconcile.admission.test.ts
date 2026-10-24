import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { observeNativeSqliteIntegrityChecks } from "./session-accessor.sqlite-native-integrity.test-support.js";
import * as fixtures from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerInput } from "./session-transcript-reconcile.worker.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const roots = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.dirs) {
    await waitForSessionTranscriptIndexReconcilesInStateDir(root);
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  roots.cleanup();
  clearRuntimeConfigSnapshot();
});

async function fixture() {
  const root = roots.make("reconcile-admission-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
  const { options, scope } = fixtures.reconcileScope(root, "cold");
  await fixtures.seedTranscript(scope, "seed", "cold admission fixture");
  await waitForSessionTranscriptIndexReconcile(options);
  const database = openOpenClawAgentDatabase(options);
  fixtures.markRebuild(database.db);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  return {
    root,
    options: { ...options, path: database.path },
    scope: { ...scope, storePath: database.path },
  };
}

it("waits for a cold projection without superseding its native integrity admission", async () => {
  const { root, options, scope } = await fixture();
  closeOpenClawAgentDatabasesForTest(root);
  revokeSqliteDatabaseAdmissionsForPath(options.path);
  let parentChecks = 0;
  observeNativeSqliteIntegrityChecks(options.path, () => {
    parentChecks += 1;
  });
  const entered = createDeferred();
  probe.admission(admission, (request, grant, admit) => {
    if (request.stage === "open") {
      entered.resolve();
    }
    admit(request, grant);
  });
  startSessionTranscriptIndexReconcile(options);
  await entered.promise;
  await waitForSessionTranscriptProjection(scope);
  await waitForSessionTranscriptIndexReconcile(options);
  expect(parentChecks).toBe(0);
  expect(
    withOpenClawAgentDatabaseReadOnly(
      ({ db }) => db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
      options,
    ),
  ).toEqual({ found: true, value: { needs_rebuild: 0 } });
});

it.each(["direct", "deferred"] as const)(
  "retains the operation environment before %s admission",
  async (mode) => {
    const { options } = await fixture();
    const nextRoot = roots.make("reconcile-next-owner-");
    const original = { ...options, env: { ...options.env } };
    const inputs: SessionTranscriptReconcileWorkerInput[] = [];
    observer.onTask = ({ input }) => inputs.push(input);
    const task = mode === "direct" ? reconcileSessionTranscriptIndexes(options) : undefined;
    if (mode === "deferred") {
      startSessionTranscriptIndexReconcile(options);
    }
    options.env.OPENCLAW_STATE_DIR = nextRoot;
    if (task) {
      await expect(task).resolves.toEqual({ reconciledSessions: 1 });
    } else {
      await waitForSessionTranscriptIndexReconcile(original);
    }
    expect(inputs).toContainEqual(
      expect.objectContaining({ mode: "disk", stateDir: original.env.OPENCLAW_STATE_DIR }),
    );
    expect(fs.readdirSync(nextRoot)).toEqual([]);
  },
);
