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
  vi.clearAllMocks();
});

it("observes and stops the same process after the model turn has settled without starting another turn", async () => {
  const descriptor = {
    ...testWorkerDescriptor(process.cwd()),
    connectionEndpoint: TEST_WORKER_ENDPOINT,
  };
  const record = createProcessSessionFixture({ id: "retained-build", backgrounded: true });
  record.scopeKey = "worker:" + descriptor.admission.sessionId;
  record.agentId = descriptor.assignment.agentId;
  record.processActivity = { resultSettled: false, lastOutputAtMs: record.startedAt };
  addSession(record);
  appendOutput(record, "stdout", "Build is running\n");
  vi.mocked(runWorkerDescriptor).mockResolvedValue({
    status: "completed",
    transcriptLeafId: null,
    transcriptNextSeq: 1,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map<string, ReturnType<typeof createDeferred<WorkerProcessMessage>>>();
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      const frame = parseWorkerProcessMessage(JSON.parse(line));
      if (frame) {
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
  try {
    expect(
      await request("turn", { type: "turn", turnId: descriptor.assignment.turnId, descriptor }),
    ).toMatchObject({ type: "result", retainWorker: true });
    const binding = {
      type: "process",
      environmentId: descriptor.admission.environmentId,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
    };
    const list = await request("list", {
      ...binding,
      requestId: "list",
      operation: { action: "list" },
    });
    expect(list).toMatchObject({
      type: "process-result",
      result: {
        sessionId: descriptor.admission.sessionId,
        processes: [{ processId: record.id, tail: "Build is running\n" }],
      },
    });
    if (list.type !== "process-result" || !list.result || !("processes" in list.result)) {
      throw new Error("Expected process list");
    }
    const row = list.result.processes[0]!;
    expect(
      await request("stale", {
        ...binding,
        ownerEpoch: binding.ownerEpoch + 1,
        requestId: "stale",
        operation: { action: "stop", processId: row.processId, instanceId: row.instanceId },
      }),
    ).toMatchObject({ error: expect.stringContaining("owner changed") });
    expect(cancel).not.toHaveBeenCalled();
    expect(
      await request("stop", {
        ...binding,
        requestId: "stop",
        operation: { action: "stop", processId: row.processId, instanceId: row.instanceId },
      }),
    ).toMatchObject({ result: { requested: true } });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(record.id, "manual-cancel");
    expect(runWorkerDescriptor).toHaveBeenCalledOnce();
    expect(record.pendingOutput).toEqual([{ stream: "stdout", text: "Build is running\n" }]);
    expect(record.terminalPollObserved).toBeUndefined();
  } finally {
    markExited(record, 0, null, "completed");
    input.end();
    await running;
  }
});
