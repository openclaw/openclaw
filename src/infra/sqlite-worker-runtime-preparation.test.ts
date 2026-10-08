import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BroadcastChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { useSqliteWorkerStoreFixture } from "./sqlite-worker-fixture.test-support.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import * as workerCpu from "./worker-cpu.js";

const { tempDirs } = useSqliteWorkerStoreFixture("sqlite-runtime-preparation-");

it.each([false, true])(
  "preloads code until native retirement and reuses the winning actor (ordinary opener: %s)",
  async (ordinaryWins) => {
    const directory = tempDirs.make("sqlite-runtime-preparation-");
    const moduleUrl = pathToFileURL(path.join(directory, "backend.mts"));
    const databasePath = path.join(directory, "successor.sqlite");
    const markerPath = path.join(directory, "factory-entered");
    const loaded = createDeferredCore<number>();
    const channel = new BroadcastChannel(directory);
    channel.addEventListener("message", (event) => loaded.resolve(Number(event.data)));
    const backendUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url);
    await writeFile(
      moduleUrl,
      `
import { BroadcastChannel, threadId } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { createSqliteWorkerBackend as createBackend } from ${JSON.stringify(backendUrl.href)};
const loaded = new BroadcastChannel(${JSON.stringify(directory)});
loaded.postMessage(threadId);
loaded.close();
export function createSqliteWorkerBackend(input, context) {
  writeFileSync(${JSON.stringify(markerPath)}, "native factory entered");
  return createBackend(input, context);
}
`,
    );
    const broker = new SqliteWorkerBroker();
    const createdWorkers = vi.spyOn(workerCpu, "createCpuTrackedWorker");
    let prepared: ReturnType<typeof broker.prepareRuntime>;
    try {
      let predecessorStopped: Promise<void> | undefined;
      const predecessor = await broker.open<FixtureOperations>(
        {
          moduleUrl: backendUrl,
          databasePath: path.join(directory, "predecessor.sqlite"),
          input: undefined,
        },
        undefined,
        undefined,
        {
          onNativeStopped(stopped) {
            predecessorStopped = stopped;
          },
        },
      );
      assert(predecessor);
      const before = await predecessor.execute({ type: "append", input: { value: "before" } });
      expect(
        broker.prepareRuntime({
          moduleUrl,
          runtimeGeneration: {
            resolve: (url) => url,
            retain() {
              throw new Error("Code preparation must not retain an updater generation");
            },
          },
        }),
      ).toBeUndefined();
      prepared = broker.prepareRuntime({ moduleUrl });
      assert(prepared);
      const preparedWorker = createdWorkers.mock.results
        .flatMap((result) => (result.type === "return" ? [result.value] : []))
        .at(-1);
      assert(preparedWorker);
      const failLoading = (error: Error) => loaded.reject(error);
      const exitBeforeLoading = (code: number) =>
        loaded.reject(new Error(`Prepared worker exited before importing the fixture: ${code}`));
      preparedWorker.once("error", failLoading);
      preparedWorker.once("exit", exitBeforeLoading);
      const preparedThread = await loaded.promise;
      preparedWorker.off("error", failLoading);
      preparedWorker.off("exit", exitBeforeLoading);
      expect(preparedWorker.threadId).toBe(preparedThread);
      let preparedExited = false;
      preparedWorker.once("exit", () => {
        preparedExited = true;
      });
      expect(preparedThread).not.toBe(before.threadId);
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(databasePath)).toBe(false);

      const closing = broker.close();
      await expect(predecessor.execute({ type: "read", input: undefined })).rejects.toMatchObject({
        code: "closed",
      });
      await closing;
      assert(predecessorStopped);
      await predecessorStopped;
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(databasePath)).toBe(false);

      const options = { moduleUrl, databasePath, input: undefined };
      const ordinary = ordinaryWins ? await broker.open<FixtureOperations>(options) : undefined;
      const winningReceipt = await ordinary?.execute({
        type: "append",
        input: { value: "ordinary" },
      });
      if (ordinaryWins) {
        assert(winningReceipt);
        expect(winningReceipt.threadId).not.toBe(preparedThread);
      }
      const successor = await broker.open<FixtureOperations>(options, undefined, undefined, {
        runtimePreparation: prepared,
      });
      assert(successor);
      expect(preparedExited).toBe(ordinaryWins);
      expect(await successor.execute({ type: "append", input: { value: "after" } })).toMatchObject({
        threadId: winningReceipt?.threadId ?? preparedThread,
        writes: ordinaryWins ? 2 : 1,
      });
      expect(existsSync(markerPath)).toBe(true);
      await prepared.release();
      expect(await successor.execute({ type: "read", input: undefined })).toEqual(
        ordinaryWins ? ["ordinary", "after"] : ["after"],
      );
      await expect(
        broker.open(options, undefined, undefined, { runtimePreparation: prepared }),
      ).rejects.toMatchObject({ code: "closed" });
      await expect(
        broker.open(
          { ...options, databasePath: path.join(directory, "reused.sqlite") },
          undefined,
          undefined,
          { runtimePreparation: prepared },
        ),
      ).rejects.toMatchObject({ code: "closed" });
      expect(existsSync(path.join(directory, "reused.sqlite"))).toBe(false);
    } finally {
      channel.close();
      try {
        await prepared?.release();
        await broker.close();
      } finally {
        createdWorkers.mockRestore();
      }
    }
  },
);

it("refuses a failed preload instead of treating it as capacity preemption", async () => {
  const directory = tempDirs.make("sqlite-runtime-preload-failure-");
  const moduleUrl = pathToFileURL(path.join(directory, "backend.mjs"));
  const databasePath = path.join(directory, "must-not-open.sqlite");
  await writeFile(moduleUrl, 'throw new Error("Fixture runtime import refused");');
  const broker = new SqliteWorkerBroker();
  const createdWorkers = vi.spyOn(workerCpu, "createCpuTrackedWorker");
  let prepared: ReturnType<typeof broker.prepareRuntime>;
  try {
    prepared = broker.prepareRuntime({ moduleUrl });
    assert(prepared);
    const worker = createdWorkers.mock.results
      .flatMap((result) => (result.type === "return" ? [result.value] : []))
      .at(-1);
    assert(worker);
    const failed = createDeferredCore<Error>();
    const exited = createDeferredCore();
    worker.once("error", failed.resolve);
    worker.once("exit", () => exited.resolve());
    expect((await failed.promise).message).toContain("Fixture runtime import refused");
    await exited.promise;
    await broker.close();
    await expect(
      broker.open({ moduleUrl, databasePath, input: undefined }, undefined, undefined, {
        runtimePreparation: prepared,
      }),
    ).rejects.toMatchObject({ code: "closed" });
    expect(existsSync(databasePath)).toBe(false);
  } finally {
    try {
      await prepared?.release();
      await broker.close();
    } finally {
      createdWorkers.mockRestore();
    }
  }
});
