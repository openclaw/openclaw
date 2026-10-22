import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { addSession, appendOutput, markExited } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testWorkerDescriptor,
} from "../node-host/node-worker-supervisor.test-support.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import type { WorkerProcessOperation } from "./worker-process-observation.js";
import { parseWorkerProcessMessage, type WorkerProcessMessage } from "./worker-process-protocol.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

vi.mock("./worker.runtime.js", () => ({
  runWorkerDescriptor: vi.fn(),
  createWorkerRuntimeEnvironment: async () => ({
    stateDir: "/synthetic/worker-state",
    close: async () => {},
  }),
}));
vi.mock("./github-binding.runtime.js", () => ({ disposeWorkerGitHubEnvironment: async () => {} }));
const { cancel } = vi.hoisted(() => ({ cancel: vi.fn(() => true) }));
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ cancel }) }));
afterEach(() => {
  resetProcessRegistryForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([true, false])(
  "observes retained processes and publishes changes only when negotiated=%s",
  async (processChanges) => {
    vi.useFakeTimers();
    const descriptor = {
      ...testWorkerDescriptor(process.cwd()),
      connectionEndpoint: TEST_WORKER_ENDPOINT,
    };
    const { sessionId, environmentId, ownerEpoch } = descriptor.admission;
    const processFixture = (id: string, ownerSession = sessionId) => {
      const process = Object.assign(createProcessSessionFixture({ id, backgrounded: true }), {
        scopeKey: `worker:${ownerSession}`,
        agentId: descriptor.assignment.agentId,
      });
      addSession(process);
      return process;
    };
    const record = processFixture("retained-build");
    record.processActivity = { resultSettled: false, lastOutputAtMs: record.startedAt };
    appendOutput(record, "stdout", "Build is running\n");
    vi.mocked(runWorkerDescriptor).mockResolvedValue({
      status: "completed",
      transcriptLeafId: null,
      transcriptNextSeq: 1,
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const waiting = new Map<string, ReturnType<typeof createDeferred<WorkerProcessMessage>>>();
    const changes: WorkerProcessMessage[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const frame = parseWorkerProcessMessage(JSON.parse(line));
        if (frame?.type === "processes-changed") {
          changes.push(frame);
        } else if (frame) {
          waiting.get(frame.type === "process-result" ? frame.requestId : "turn")?.resolve(frame);
        }
      }
    });
    const request = (id: string, value: unknown) => {
      const result = createDeferred<WorkerProcessMessage>();
      waiting.set(id, result);
      input.write(JSON.stringify(value) + "\n");
      return result.promise;
    };
    const running = runWorkerCommand({ input, output, managed: true });
    const binding = { type: "process", environmentId, sessionId, ownerEpoch };
    const observe = (
      requestId: string,
      operation: WorkerProcessOperation,
      epoch = binding.ownerEpoch,
    ) => request(requestId, { ...binding, requestId, operation, ownerEpoch: epoch });
    const expectChanges = async (count: number) => {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toHaveLength(processChanges ? count : 0);
    };
    try {
      expect(
        await request("turn", {
          type: "turn",
          turnId: descriptor.assignment.turnId,
          descriptor,
          ...(processChanges ? { processChanges: true } : {}),
        }),
      ).toMatchObject({ type: "result", retainWorker: true });
      const list = await observe("list", { action: "list" });
      expect(list).toMatchObject({
        type: "process-result",
        result: {
          sessionId,
          processes: [{ processId: record.id, tail: "Build is running\n" }],
        },
      });
      if (list.type !== "process-result" || !list.result || !("processes" in list.result)) {
        throw new Error("Expected process list");
      }
      const { processId, instanceId } = list.result.processes[0]!;
      const stop: WorkerProcessOperation = { action: "stop", processId, instanceId };
      expect(await observe("stale", stop, binding.ownerEpoch + 1)).toMatchObject({
        error: expect.stringContaining("owner changed"),
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(await observe("stop", stop)).toMatchObject({ result: { requested: true } });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(record.id, "manual-cancel");
      expect(runWorkerDescriptor).toHaveBeenCalledOnce();
      expect(record.pendingOutput).toEqual([{ stream: "stdout", text: "Build is running\n" }]);
      expect(record.terminalPollObserved).toBeUndefined();
      await expectChanges(1);
      expect(await observe("stopping", { action: "list" })).toMatchObject({
        result: { processes: [{ processId: record.id, status: "running", canStop: false }] },
      });
      appendOutput(record, "stdout", "Build output after the turn\n");
      await expectChanges(2);
      const other = processFixture("another-owner", "another-session");
      appendOutput(other, "stdout", "Unrelated output\n");
      await expectChanges(2);
      appendOutput(record, "stdout", "Build progressed after the turn\n");
      await expectChanges(3);
      markExited(record, 0, null, "completed");
      await expectChanges(4);
    } finally {
      markExited(record, 0, null, "completed");
      input.end();
      await running;
    }
  },
);
