import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import type { OpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getOpenClawStateWorkerOwner } from "../state/openclaw-state-worker-owner.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { removeTempDirectoryAsync } from "./sqlite-readonly-location-cleanup.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-allocation.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  getSqliteWorkerActorIdentity,
  isSqliteWorkerStoreAvailable,
} from "./sqlite-worker-store.js";

const [root, scenario] = process.argv.slice(2);
assert.ok(root, "SQLite lifecycle retention requires its temporary directory");
const callerContext = new AsyncLocalStorage<object>();

class RetainedCaller {
  prompt = Buffer.alloc(1024 * 1024);
}

const referencesTo = (...objects: object[]) => objects.map((object) => new WeakRef(object));

async function assertCollected(references: WeakRef<object>[]) {
  await collectForRetentionCheck(`sqlite-${scenario}`);
  assert.equal(references.filter((reference) => reference.deref()).length, 0);
}

function captureStagingCaller() {
  const caller = new RetainedCaller();
  return {
    owner: callerContext.run(caller, captureSqliteSnapshotStagingOwner),
    references: referencesTo(caller, caller.prompt),
  };
}

async function checkStaging() {
  const { owner, references } = captureStagingCaller();
  // Per-request custody has its own lifetime; this caller only creates the reusable owner.
  const directory = await allocateWorkerOwnedSqliteSnapshotDirectory(root!, false);
  try {
    assert.ok(existsSync(directory.directory));
    await assertCollected(references);
    assert.equal(captureSqliteSnapshotStagingOwner(), owner);
    const second = await allocateWorkerOwnedSqliteSnapshotDirectory(root!, false);
    assert.notEqual(second.directory, directory.directory);
    assert.equal(await removeTempDirectoryAsync(second.directory), true);
  } finally {
    assert.equal(await removeTempDirectoryAsync(directory.directory), true);
  }
}

const readCommand = {
  type: "deviceAuth.read",
  input: { deviceId: "lifecycle-retention", role: "operator", readOnly: false },
} as const;

async function completeStateOpening() {
  const caller = new RetainedCaller();
  const authority = new RetainedCaller();
  const context = captureOpenClawStateWorkerContext();
  const references = referencesTo(caller, caller.prompt, authority, authority.prompt);
  await callerContext.run(caller, async () => {
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(readCommand),
      {
        assertCurrent() {
          assert.equal(callerContext.getStore(), caller);
          assert.equal(authority.prompt.byteLength, 1024 * 1024);
        },
      },
    );
    assert.deepEqual(result, { entry: null, expectedToken: null });
  });
  return { references, context };
}

async function checkStateOpening() {
  try {
    const { references, context } = await completeStateOpening();
    const owner = getOpenClawStateWorkerOwner();
    const store = await owner.open(context);
    assert.ok(store);
    const actor = getSqliteWorkerActorIdentity(store);
    await assertCollected(references);
    assert.equal(isSqliteWorkerStoreAvailable(store), true);
    assert.equal(await owner.open(context), store);
    assert.equal(getSqliteWorkerActorIdentity(store), actor);
    assert.deepEqual(
      await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(readCommand)),
      { entry: null, expectedToken: null },
    );
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}

async function completeAgentCaller(
  execution: OpenClawAgentDatabaseExecution,
  context: ReturnType<typeof captureOpenClawStateWorkerContext>,
  prepare = false,
) {
  const caller = new RetainedCaller();
  // Keep this lexical: an opening Promise's async context is a separate contract.
  const source: Parameters<OpenClawAgentDatabaseExecution["prepare"]>[0] = {
    assertCurrent() {
      context.admission.assertCurrent();
      assert.equal(caller.prompt.byteLength, 1024 * 1024);
    },
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          binding.assertCurrent();
          source.assertCurrent();
          assert.ok(grant(), "The current agent caller must retain native admission");
        }, binding.attachment),
      });
    },
  };
  const references = referencesTo(caller, caller.prompt, source);
  if (prepare) {
    await execution.prepare(source);
  } else {
    const result = await execution.runExisting(source, async (scope) => {
      await scope.execute({ type: "database.prepareWrite", input: undefined });
      return "completed";
    });
    assert.equal(result, "completed");
  }
  return references;
}

async function checkAgentOpening() {
  let execution: OpenClawAgentDatabaseExecution | undefined;
  try {
    // Establish shared identity before the agent's creating admission captures it.
    openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    execution = captureOpenClawAgentDatabaseExecution({ agentId: "main" });
    const references = await completeAgentCaller(execution, context, true);
    const generation = execution.capturePreparedGenerationClaim();
    assert.ok(generation);
    for (let cycle = 0; cycle < 100; cycle += 1) {
      references.push(...(await completeAgentCaller(execution, context)));
    }
    await assertCollected(references);
    const current = execution.capturePreparedGenerationClaim();
    assert.ok(current, "Collection must happen while the native generation stays prepared");
    generation.assertCurrent();
    assert.equal(current.identity, generation.identity);
    assert.equal(current.incarnation, generation.incarnation);
  } finally {
    try {
      await execution?.release();
    } finally {
      try {
        await closeOpenClawAgentDatabasesAsync();
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    }
  }
}

async function checkHistoryClose() {
  const sessions = await import("../config/sessions/session-accessor.js");
  const history = await import("../config/sessions/session-accessor.sqlite-history-events.js");
  const { openOpenClawAgentDatabase } = await import("../state/openclaw-agent-db.js");
  const { OpenClawAgentDatabaseReadOnlyScope } =
    await import("../state/openclaw-agent-db-readonly-scope.js");
  const { withOpenClawAgentDatabaseReadOnly } =
    await import("../state/openclaw-agent-db-readonly.js");
  const scope = {
    agentId: "main",
    sessionId: "history-retention",
    sessionKey: "agent:main:history-retention",
    env: process.env,
  };
  const reader = new OpenClawAgentDatabaseReadOnlyScope();
  try {
    sessions.replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await sessions.persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "message", parentId: null, message: { role: "user", content: "hello" } },
      ],
      touchSessionEntry: false,
    });
    const target = { agentId: scope.agentId, path: openOpenClawAgentDatabase(scope).path };
    await closeOpenClawAgentDatabasesAsync(root);
    const reference = reader.run(target, () => {
      const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
        const page = history.readSessionTranscriptHistoryEventPage(scope, {
          offset: 0,
          maxMessages: 1,
          readOnly: true,
        });
        assert.equal(page.events.length, 1);
        return new WeakRef(db);
      }, scope);
      assert.ok(result.found);
      return result.value;
    });
    assert.equal(reader.hasRetainedConnection, true);
    reader.close();
    await collectForRetentionCheck("sqlite-history-close");
    assert.equal(reference.deref(), undefined, "Closed history database must collect");
    assert.equal(reader.hasRetainedConnection, false);
  } finally {
    reader.close();
    await closeOpenClawAgentDatabasesAsync(root);
    await closeOpenClawStateDatabaseAsync();
  }
}

const scenarios = new Map<string, () => Promise<void>>([
  ["snapshot-staging", checkStaging],
  ["state-opening", checkStateOpening],
  ["agent-opening", checkAgentOpening],
  ["history-close", checkHistoryClose],
]);
const run = scenarios.get(scenario ?? "");
if (!run) {
  throw new Error(`Unknown SQLite lifecycle retention scenario: ${scenario}`);
}
await run();
process.stdout.write(JSON.stringify({ scenario, collected: true, reused: true }));
