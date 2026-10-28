import { expect, it, vi } from "vitest";
import { NativeWorker } from "./worker-native-handle.js";
import type { NativeWorkerRuntime } from "./worker-native-lifecycle.types.js";

it.each(["execution", "resource"] as const)(
  "joins independent %s-first receipts after the resource transport failed",
  async (first) => {
    let closeResource: (() => void) | undefined;
    let failResource: ((error: Error) => void) | undefined;
    const release = vi.fn();
    type ResourceBroker = ReturnType<NativeWorkerRuntime["resourceBroker"]>;
    const broker: ResourceBroker = {
      captureNativeResource: vi.fn<ResourceBroker["captureNativeResource"]>((_input, callbacks) => {
        closeResource = () => callbacks.message({ type: "resource-closed", id: 1, requestId: 0 });
        failResource = (error) => callbacks.failed(error);
        return {
          attachment: {
            endpoint: "synthetic-endpoint",
            secret: "synthetic-secret",
            generation: 1,
            id: 1,
            moduleUrl: "file:///synthetic/resource.mjs",
            ownerPort: false,
          },
          receive: vi.fn(),
          ownerMessage: vi.fn(() => ({ sequence: 1 })),
          close: vi.fn(async () => {}),
          release,
          abandonUnattached: vi.fn(),
        };
      }),
      sealNativeResources: vi.fn<ResourceBroker["sealNativeResources"]>().mockResolvedValue(),
    };
    const post = vi.fn();
    const runtime: NativeWorkerRuntime = {
      handles: new Map(),
      service: vi.fn(),
      post,
      refreshReference: vi.fn(),
      resourceBroker: () => broker,
    };
    const worker = new NativeWorker(
      runtime,
      1,
      new URL("file:///synthetic/worker.mjs"),
      false,
      true,
    );
    const exited = vi.fn();
    const failed = vi.fn();
    worker.on("exit", exited);
    worker.on("error", failed);
    worker.attachResource({
      moduleUrl: "file:///synthetic/resource.mjs",
      workerDataKey: "resource",
    });
    const failure = new Error("synthetic broker startup failure");
    failResource!(failure);
    expect(failed).toHaveBeenCalledWith(failure);
    const stopped = worker.stop();
    const observeExecution = () => worker.receive({ type: "execution-exit", id: 1, code: 7 });
    const observeResource = () => closeResource!();
    (first === "execution" ? observeExecution : observeResource)();
    expect(stopped.read().status).toBe("pending");
    (first === "execution" ? observeResource : observeExecution)();
    await stopped.result;
    expect(worker.needsReference).toBe(false);
    expect(exited).toHaveBeenCalledOnce();
    expect(exited).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: "release", id: 1 });
    worker.receive({ type: "stopped", id: 1, code: 0 });
    expect(exited).toHaveBeenCalledOnce();
  },
);
