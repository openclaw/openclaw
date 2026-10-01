import assert from "node:assert/strict";
import path from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";

function requireBrokerCloseResult(
  result: Promise<void> | undefined,
  error: unknown,
): Promise<void> {
  if (!(result instanceof Promise)) {
    throw new Error("Original broker close returned no Promise", { cause: error });
  }
  return result;
}

export async function runNativeGenerationRefusal(directory: string) {
  const { mkdirSync, existsSync } = await import("node:fs");
  const { requireNodeSqlite } = await import("./node-sqlite.js");
  const { DatabaseSync } = requireNodeSqlite();
  const { createDeferredCore } = await import("../shared/deferred.js");
  const { withRuntimeWorkerGeneration } = await import("./runtime-worker-generation.js");
  const { captureRetainedNativeWorkerSource } = await import("./worker-native-lifecycle.js");
  const { startWorkerOwnedSqliteStagingToken } = await import("./sqlite-snapshot-staging-owner.js");
  const { SpawnBrokerHost } = await import("../process/spawn-broker/host.js");
  const tokenDirectory = path.join(directory, "retained-token");
  mkdirSync(tokenDirectory);
  let admission: ReturnType<typeof startWorkerOwnedSqliteStagingToken> | undefined;
  let supervisor: Worker | undefined;
  let observer: SqliteDatabase | undefined;
  let targetJoined = false;
  let supervisorJoined = false;
  let released = false;
  let retained = false;
  const supervisorExit = createDeferredCore();
  void supervisorExit.promise.catch(() => undefined);
  const registrations = mock.method(Worker.prototype, "on");
  const brokerClosures = mock.method(SpawnBrokerHost.prototype, "close");
  let bodyFailure: { error: unknown } | undefined;
  try {
    const generation = withRuntimeWorkerGeneration(
      async (bind) => {
        bind((url) => {
          const captured = new URL(url);
          captured.searchParams.set("native-lifecycle-test-generation", "refused-token");
          return captured;
        });
        const source = captureRetainedNativeWorkerSource();
        const creations = mock.method(source, "create");
        try {
          admission = startWorkerOwnedSqliteStagingToken(tokenDirectory, "create");
          const token = await admission.result;
          assert.equal(token.isCurrent(), true);
          assert.equal(creations.mock.calls.length, 1);
          const target = creations.mock.calls[0]?.result;
          assert.ok(target !== undefined);
          target.once("exit", () => {
            targetJoined = true;
          });
          supervisor = registrations.mock.calls
            .map((call) => call.this)
            .find((value) => value instanceof Worker);
          assert.ok(supervisor instanceof Worker);
          supervisor.once("exit", () => {
            supervisorJoined = true;
            supervisorExit.resolve();
          });
          const database = new DatabaseSync(path.join(tokenDirectory, "owner.sqlite"));
          observer = database;
          database.exec("PRAGMA busy_timeout=0");
          assert.throws(() => database.exec("BEGIN IMMEDIATE"), /locked|busy/i);
        } finally {
          creations.mock.restore();
          registrations.mock.restore();
        }
      },
      async () => {
        released = true;
      },
      () => {
        retained = true;
        return directory;
      },
    );
    let originalFailure: unknown;
    await assert.rejects(generation, (error: unknown) => {
      originalFailure = error;
      assert.equal(error instanceof AggregateError, true);
      if (!(error instanceof AggregateError)) {
        return false;
      }
      const owner: unknown = error.errors[0];
      assert.equal(owner instanceof AggregateError, true);
      if (!(owner instanceof AggregateError)) {
        return false;
      }
      const refusal: unknown = owner.errors[0];
      const native: unknown = owner.errors[1];
      assert.equal(refusal instanceof AggregateError, true);
      if (!(refusal instanceof AggregateError)) {
        return false;
      }
      const heldToken: unknown = refusal.errors[0];
      assert.equal(
        heldToken instanceof Error &&
          heldToken.message === "SQLite staging token still has its plugin owner",
        true,
      );
      assert.equal(
        native instanceof Error &&
          native.message === "Native worker execution owners have not joined",
        true,
      );
      return true;
    });
    assert.equal(retained, true);
    assert.equal(released, false);
    assert.equal(targetJoined, false);
    assert.equal(supervisorJoined, false);
    assert.equal(brokerClosures.mock.calls.length, 0);
    assert.ok(observer !== undefined);
    const database = observer;
    assert.throws(() => database.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    assert.ok(admission !== undefined);
    await admission.startRelease().result;
    assert.equal(targetJoined, true);
    observer.exec("BEGIN IMMEDIATE");
    assert.equal(observer.prepare("PRAGMA user_version").get()?.user_version, 0);
    observer.exec("ROLLBACK");
    const deadline = setTimeout(
      () =>
        supervisorExit.reject(
          new Error("Original native supervisor did not join after token release"),
        ),
      10_000,
    );
    try {
      await supervisorExit.promise;
    } finally {
      clearTimeout(deadline);
    }
    await nextTurn();
    assert.equal(brokerClosures.mock.calls.length > 0, true);
    await Promise.all(
      brokerClosures.mock.calls.map((call) => requireBrokerCloseResult(call.result, call.error)),
    );
    await assert.rejects(generation, (error: unknown) => error === originalFailure);
    assert.equal(released, false);
    assert.equal(existsSync(tokenDirectory), true);
  } catch (error) {
    bodyFailure = { error };
  }
  // The old-source negative control must also join its original native custody.
  const cleanupFailures: unknown[] = [];
  try {
    await admission?.startRelease().result;
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    observer?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await supervisor?.terminate();
  } catch (error) {
    cleanupFailures.push(error);
  }
  await nextTurn();
  const pendingBrokerCloses: Promise<void>[] = [];
  for (const call of brokerClosures.mock.calls) {
    try {
      pendingBrokerCloses.push(requireBrokerCloseResult(call.result, call.error));
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  for (const result of await Promise.allSettled(pendingBrokerCloses)) {
    if (result.status === "rejected") {
      cleanupFailures.push(result.reason);
    }
  }
  registrations.mock.restore();
  brokerClosures.mock.restore();
  if (bodyFailure || cleanupFailures.length) {
    const failures = bodyFailure ? [bodyFailure.error, ...cleanupFailures] : cleanupFailures;
    throw new AggregateError(failures, "Generation refusal fixture failed", { cause: failures[0] });
  }
  console.log(
    JSON.stringify({
      ending: "generation-refusal",
      originalFailurePreserved: true,
      generationRetained: true,
      tokenClosedWithoutRetirement: true,
      nativeTargetJoined: targetJoined,
      supervisorJoined,
      brokerJoined: true,
    }),
  );
}
