import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
} from "../infra/gateway-state-owner.js";
import { captureSqliteWorkerCreationPaths } from "../infra/sqlite-worker-broker-admission.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type {
  SummaryInput,
  SummaryResult,
  SummaryScenario,
} from "./openclaw-state.worker.summary.test-support.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  expect(isMainThread).toBe(true);
  state = await createOpenClawTestState({ prefix: "openclaw-native-handles-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

async function runSummary(scenario: SummaryScenario, signal: AbortSignal) {
  const databasePath = resolveOpenClawStateSqlitePath(state.env);
  if (scenario.kind === "promotion") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "");
  } else {
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
  }
  const context = captureOpenClawStateWorkerContext({ path: databasePath, env: state.env });
  const identity = context.admission.identity;
  const assertCurrent = () => {
    signal.throwIfAborted();
    context.admission.assertCurrent();
  };
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    assertCurrent();
    grant();
  });
  let schemaLease: ReturnType<typeof acquireStateDatabaseSchemaLease> | undefined;
  admission.bindDatabaseAuthority({
    databasePath: identity.canonicalPath,
    databaseIdentity: { databasePath, key: identity.key, birthtime: identity.birthtime },
    assertRequest: assertCurrent,
    assertAccess: () => assertStateDatabaseAccessAllowed(databasePath, { schemaLease }),
    acquireSchema: () => (schemaLease = acquireStateDatabaseSchemaLease(databasePath)),
    ...captureSqliteWorkerCreationPaths({
      companions: {
        primary: databasePath,
        paths: [resolveQuarantineStorePath(context.environment)],
      },
    }),
  });
  const pool = createOwnedWorkerTaskPool<SummaryInput, SummaryResult>({
    workerUrl: new URL("./openclaw-state.worker.summary.test-support.ts", import.meta.url),
    maxWorkers: 1,
    idleTimeoutMs: 0,
  });
  try {
    const result = await pool.run(
      {
        scenario,
        context: captureSqliteWorkerStateContext(context),
        databasePath,
        identity: identity.key,
        port: admission.port,
      },
      { signal, transferList: (input) => [input.port] },
    );
    expect(result).toEqual({ completed: scenario, isMainThread: false });
  } finally {
    // The worker settles native handles before releasing its host admission and fixture.
    try {
      await pool.close();
    } finally {
      await admission.finish();
    }
  }
}

it.for(["kv", "health"] as const)(
  "retains a promoted KV actor's native handle when %s closes first",
  async (firstToClose, { signal }) => {
    await runSummary({ kind: "promotion", firstToClose }, signal);
  },
);

it.for(["config.health.patch", "diagnostic.register"] as const)(
  "retains %s writes from existing-only actors until last close and durably reopens",
  async (operation, { signal }) => {
    await runSummary({ kind: "existing", operation }, signal);
  },
);
