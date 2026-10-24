import assert from "node:assert/strict";
import {
  createSubagentStoreRunFixture,
  saveSubagentRegistryToSqlite,
} from "../../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { readAllSubagentRunsInWorker } from "../../src/agents/subagents/registry/subagent-registry.store.read.js";
import {
  registerSealedRuntimeProcessEntrypoint,
  resolveRuntimeProcessEntrypointUrl,
} from "../../src/infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../../src/infra/runtime-worker-generation.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../../src/infra/worker-native-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { transcriptSessionSelector, TranscriptsStore } from "../../src/transcripts/store.js";

const [mode, entrypoint] = process.argv.slice(2);
assert.ok(mode === "restore" || mode === "export", "Expected restore or export fixture");
assert.ok(entrypoint, "Expected emitted state read entrypoint");
const emitted = new URL(entrypoint);
assert.equal(emitted.protocol, "file:");

async function closeRuntime(): Promise<void> {
  try {
    await closeOpenClawStateDatabaseAsync();
  } finally {
    await closeDefaultRetainedNativeWorkerSource();
  }
}

const state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
let values: string[];
let workerUrl: string;
try {
  const store = new TranscriptsStore(state.statePath("transcripts"), { env: state.env });
  const session = {
    sessionId: "emitted-stream",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-07-01T10:00:00.000Z",
  };
  if (mode === "restore") {
    const rows = [
      ["restore-third", 30],
      ["restore-first", 10],
      ["restore-second", 20],
    ] as const;
    saveSubagentRegistryToSqlite(
      new Map(
        rows.map(([runId, createdAt]) => [
          runId,
          createSubagentStoreRunFixture({
            runId,
            childSessionKey: `agent:main:subagent:${runId}`,
            task: runId,
            createdAt,
            completion: { required: false },
            delivery: { status: "not_required" },
          }),
        ]),
      ),
    );
  } else {
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "first" });
    await store.appendUtteranceForSession(session, { text: "second" });
  }

  // Seeding may capture source workers. Retire them before the first emitted read capture.
  await closeRuntime();
  registerSealedRuntimeProcessEntrypoint("stateRead", emitted);
  const nativeSource = captureRetainedNativeWorkerSource();
  assert.equal(nativeSource.hasActiveWorkers, false);
  const captured = captureRuntimeWorkerSource(resolveRuntimeProcessEntrypointUrl("stateRead"));
  workerUrl = captured.moduleUrl.href;
  assert.equal(workerUrl, emitted.href);
  assert.equal(captured.runtimeGeneration, undefined);

  if (mode === "restore") {
    const runs = await readAllSubagentRunsInWorker(
      captureOpenClawStateWorkerContext({ env: state.env }),
    );
    values = [...runs.keys()];
    assert.deepEqual(values, ["restore-first", "restore-second", "restore-third"]);
    assert.deepEqual(
      [...runs.values()].map((row) => row.task),
      values,
    );
  } else {
    values = [];
    const result = await store.streamExport(transcriptSessionSelector(session), false, (rows) => {
      values.push(...rows.map((row) => row.text));
    });
    assert.deepEqual(values, ["first", "second"]);
    assert.equal(result.entry.session.sessionId, session.sessionId);
    assert.equal(result.entry.session.startedAt, session.startedAt);
    assert.equal(result.notes, undefined);
  }
} finally {
  await closeRuntime();
  await state.cleanup();
}
console.log(JSON.stringify({ mode, workerUrl, values }));
