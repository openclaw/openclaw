import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerServer from "../gateway/server/ws-connection/worker-connection.js";
import { ComposedGatewayHarness } from "./worker-fault-injection.test-support.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("fails a worker turn after one deterministic transcript failure without reconnecting", async () => {
  const warn = vi.fn();
  const attach = workerServer.attachWorkerWsMessageHandler;
  const attachment = vi
    .spyOn(workerServer, "attachWorkerWsMessageHandler")
    .mockImplementation((params) => attach({ ...params, logGateway: { warn } }));
  onTestFinished(() => attachment.mockRestore());
  const harness = await ComposedGatewayHarness.create(tempDirs.make("oc-tf-"));
  const controller = new AbortController();
  let run: ReturnType<typeof runWorkerDescriptor> | undefined;
  try {
    await harness.start();
    const replayed = createDeferred();
    const cause = new Error("synthetic transcript storage failure");
    const commit = vi
      .spyOn(harness.serviceValue, "commitTranscript")
      .mockImplementation(async () => {
        if (commit.mock.calls.length > 1) {
          replayed.resolve();
        }
        throw new Error("transcript operation failed", { cause });
      });
    run = runWorkerDescriptor(await harness.createDescriptor(), { signal: controller.signal });
    const boundedRun = Promise.race([
      run,
      replayed.promise.then(() => {
        throw new Error("Worker replayed a deterministic transcript failure");
      }),
    ]);

    await expect(boundedRun).rejects.toMatchObject({
      name: "WorkerTranscriptCommitError",
      message: "Worker transcript commit failed; check Gateway logs.",
      response: {
        code: "UNAVAILABLE",
        retryable: false,
        details: { reason: "gateway-unavailable" },
      },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(harness.connectionCount).toBe(1);
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
    expect(harness.providerCalls).toBe(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("transcript operation failed | synthetic transcript storage failure"),
    );
  } finally {
    controller.abort(new Error("fixture teardown"));
    await Promise.allSettled([run]);
    await harness.close();
  }
});
