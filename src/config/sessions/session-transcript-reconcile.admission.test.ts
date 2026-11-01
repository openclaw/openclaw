import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { observeNativeSqliteIntegrityChecks } from "./session-accessor.sqlite-native-integrity.test-support.js";
import * as fixtures from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

afterEach(() => vi.restoreAllMocks());

async function seed(root: string) {
  const { options, scope } = fixtures.reconcileScope(root, "cold");
  await fixtures.seedTranscript(scope, "seed", "cold admission fixture");
  await waitForSessionTranscriptIndexReconcile(options);
  const database = openOpenClawAgentDatabase(options);
  fixtures.markRebuild(database.db);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  return {
    options: { ...options, path: database.path },
    scope: { ...scope, storePath: database.path },
  };
}

const fixture = (
  run: (f: Awaited<ReturnType<typeof seed>>, state: OpenClawTestState) => Promise<void>,
) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    await run(await seed(state.stateDir), state);
  });

function expectRebuilt(options: Awaited<ReturnType<typeof seed>>["options"]) {
  expect(withOpenClawAgentDatabaseReadOnly(({ db }) => fixtures.rebuildState(db), options)).toEqual(
    { found: true, value: { needs_rebuild: 0 } },
  );
}

it("waits for a cold projection without superseding its native integrity admission", () =>
  fixture(async ({ options, scope }) => {
    revokeSqliteDatabaseAdmissionsForPath(options.path);
    let parentChecks = 0;
    observeNativeSqliteIntegrityChecks(options.path, () => {
      parentChecks++;
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
    expectRebuilt(options);
  }));

it.each(["direct", "deferred"] as const)(
  "retains the operation environment before %s admission",
  (mode) =>
    fixture(async ({ options }, state) => {
      const nextRoot = state.path("next-owner");
      fs.mkdirSync(nextRoot);
      const original = { ...options, env: { ...options.env } };
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
      expectRebuilt(original);
      expect(fs.readdirSync(nextRoot)).toEqual([]);
    }),
);
