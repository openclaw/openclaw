import fs from "node:fs";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker, type MessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  SqliteWorkerCommand,
  SqliteWorkerReply,
  SqliteWorkerRequest,
} from "../infra/sqlite-worker-contract.js";
import * as workerLifecycle from "../infra/sqlite-worker-lifecycle-preparation.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { createNodeWorkerSupervisorFixture } from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

afterEach(() => {
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32")(
  "keeps physical capacity reserved after a committed turn reply becomes unknown",
  async () => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = createNodeWorkerSupervisorFixture(
      tempDirs.make("node-worker-unknown-turn-"),
      { capacity: 1, capacityWaitMs: 0, onCapacityChanged: (value) => capacities.push(value) },
    );
    const input = testWorkerLaunchInput(workspaceDir, "unknown-turn");
    const committed = createDeferred<unknown>();
    let target: { port: MessagePort | undefined; id: number } | undefined;
    let turnWrites = 0;
    // oxlint-disable-next-line typescript/unbound-method -- call preserves the sending worker.
    const postMessage = Worker.prototype.postMessage;
    const requests = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command = deserialize(
          request.input,
        ) as SqliteWorkerCommand<OpenClawStateWorkerOperations>;
        if (
          command.type === "nodeWorker.turn.finish" &&
          command.input[0].expected.launchId === input.launchId
        ) {
          turnWrites += 1;
          target ??= { port: request.lifecyclePreparation, id: request.id };
        }
      }
      return postMessage.call(this, request, transferList);
    });
    const prepareLifecycle = workerLifecycle.createSqliteWorkerLifecyclePreparation;
    const replies = vi
      .spyOn(workerLifecycle, "createSqliteWorkerLifecyclePreparation")
      .mockImplementation((params) => {
        const preparation = prepareLifecycle({
          ...params,
          receiveResult(value, pumping) {
            const reply = value as SqliteWorkerReply;
            if (target?.port === preparation.port && reply.id === target.id && reply.ok) {
              replies.mockRestore();
              committed.resolve(deserialize(reply.value));
              params.receiveResult({ ...reply, value: new Uint8Array([0]) }, pumping);
              return;
            }
            params.receiveResult(value, pumping);
          },
        });
        return preparation;
      });
    const reader = new NodeWorkerJournalWorker({ env });
    try {
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      expect(
        await withTestTimeout(committed.promise, 5_000, "The turn write did not commit"),
      ).toMatchObject({ launchId: input.launchId, state: "completed" });

      await expect(supervisor.close()).rejects.toThrow();
      await expect(supervisor.status(input.launchId)).rejects.toMatchObject({
        code: "outcome-unknown",
      });
      await expect(supervisor.cancel(testNodeWorkerLaunchIdentity(input))).rejects.toMatchObject({
        code: "outcome-unknown",
      });

      const turn = await reader.execute({ type: "nodeWorker.turn.get", input: [input.launchId] });
      expect(turn).toMatchObject({
        launchId: input.launchId,
        ownerLaunchId: input.launchId,
        state: "completed",
        errorText: null,
      });
      expect(JSON.parse(turn!.resultJson!)).toEqual({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      });
      expect(
        await reader.execute({ type: "nodeWorker.launch.get", input: [input.launchId] }),
      ).toMatchObject({ state: "running", completedAtMs: null });
      expect(await reader.execute({ type: "nodeWorker.launch.nonterminalCount", input: [] })).toBe(
        1,
      );
      expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
      expect(turnWrites).toBe(1);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${input.launchId}.started.json`), "utf8"),
        ),
      ).toMatchObject({ starts: 1 });
    } finally {
      replies.mockRestore();
      requests.mockRestore();
      await Promise.allSettled([supervisor.close(), reader.drain()]);
    }
  },
  20_000,
);
