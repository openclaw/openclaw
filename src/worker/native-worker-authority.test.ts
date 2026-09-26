import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerHelloOk } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  testWorkerLaunchInput,
  TEST_WORKER_ENDPOINT,
} from "../node-host/node-worker-supervisor.test-support.js";
import { completeWorkerLaunchDescriptor, buildWorkerConnectParams } from "./launch-descriptor.js";
import type { NativeInferenceStartup } from "./native-inference-startup.js";
import * as connections from "./worker-connection.js";
import type { WorkerConnectionState } from "./worker-connection.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const embedded = await vi.hoisted(async () => {
  const { createDeferred } = await import("../../test/helpers/promise.js");
  return {
    entered: createDeferred(),
    release: createDeferred(),
    run: vi.fn(async (params: { signal?: AbortSignal }) => {
      params.signal?.throwIfAborted();
    }),
  };
});
vi.mock("./embedded-agent.runtime.js", async () => {
  embedded.entered.resolve();
  await embedded.release.promise;
  return { runWorkerEmbeddedTurn: embedded.run };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  embedded.release.resolve();
  vi.restoreAllMocks();
  embedded.run.mockClear();
});

function fixture(native = true) {
  const root = tempDirs.make("native-admission-authority-");
  const descriptor = completeWorkerLaunchDescriptor(
    testWorkerLaunchInput(root, "authority-turn").descriptor,
    TEST_WORKER_ENDPOINT,
  );
  if (native) {
    descriptor.assignment.inference = "runtime-local";
  }
  const ref = descriptor.assignment.modelRef;
  const startup: NativeInferenceStartup = {
    credentials: { FIXTURE_NATIVE_KEY: "synthetic-authority-key" },
    config: {
      models: [
        {
          provider: ref.provider,
          id: ref.model,
          api: "openai-completions",
          baseUrl: "https://model.example.test/v1",
          contextWindow: 8192,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKeyEnv: "FIXTURE_NATIVE_KEY",
        },
      ],
      workspaces: [
        { id: descriptor.assignment.agentId, path: root, models: [ref.provider + "/" + ref.model] },
      ],
    },
  };
  const connection = connections.createWorkerConnection({
    endpoint: descriptor.connectionEndpoint,
    connectParams: buildWorkerConnectParams(descriptor),
  });
  let state: WorkerConnectionState = { kind: "idle" };
  const listeners = new Set<(state: WorkerConnectionState) => void>();
  vi.spyOn(connection, "state", "get").mockImplementation(() => state);
  vi.spyOn(connection, "onStateChange").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(connections, "createWorkerConnection").mockReturnValue(connection);
  const emit = (next: WorkerConnectionState) => {
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  const hello: WorkerHelloOk = {
    type: "worker-hello-ok",
    environmentId: descriptor.admission.environmentId,
    sessionId: descriptor.admission.sessionId,
    ownerEpoch: descriptor.admission.ownerEpoch,
    rpcSetVersion: descriptor.admission.rpcSetVersion,
    protocolFeatures: descriptor.admission.handshake.protocolFeatures,
    credentialExpiresAtMs: Date.now() + 60000,
    policy: { heartbeatIntervalMs: 60000, maxPayload: 1024 * 1024 },
  };
  const start = vi.spyOn(connection, "start");
  const run = () =>
    runWorkerDescriptor(descriptor, {
      environmentStateDir: root,
      ...(native ? { nativeInference: startup } : {}),
    });
  return { emit, hello, start, run };
}

describe("native turn admission lifetime", () => {
  it("latches authority loss while runtime imports are still awaited before the turn starts", async () => {
    const f = fixture();
    f.start.mockImplementation(async () => {
      f.emit({ kind: "ready", hello: f.hello });
      return f.hello;
    });
    const running = f.run().catch((error: unknown) => error);
    try {
      await embedded.entered.promise;
      f.emit({ kind: "connecting", attempt: 0 });
      f.emit({ kind: "ready", hello: f.hello });
    } finally {
      embedded.release.resolve();
    }
    expect(await running).toBeInstanceOf(Error);
    expect(embedded.run).not.toHaveBeenCalled();
  });
  it.each(["connecting", "admitting", "reconnecting", "stopped"] as const)(
    "rejects native departure to %s even if readmission follows",
    async (kind) => {
      const f = fixture();
      f.start.mockImplementation(async () => {
        f.emit({ kind: "ready", hello: f.hello });
        f.emit(kind === "stopped" ? { kind } : { kind, attempt: 0 });
        f.emit({ kind: "ready", hello: f.hello });
        return f.hello;
      });
      await expect(f.run()).rejects.toThrow();
      expect(embedded.run).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "preserves initial admission retries without a prior ready state (native=%s)",
    async (native) => {
      const f = fixture(native);
      f.start.mockImplementation(async () => {
        f.emit({ kind: "connecting", attempt: 0 });
        f.emit({ kind: "admitting", attempt: 0 });
        f.emit({ kind: "reconnecting", attempt: 1 });
        f.emit({ kind: "connecting", attempt: 1 });
        f.emit({ kind: "ready", hello: f.hello });
        return f.hello;
      });
      await expect(f.run()).resolves.toMatchObject({ status: "completed" });
      expect(embedded.run).toHaveBeenCalledOnce();
      expect(embedded.run.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    },
  );
  it("preserves the proxied sibling's established reconnect semantics", async () => {
    const f = fixture(false);
    f.start.mockImplementation(async () => {
      f.emit({ kind: "ready", hello: f.hello });
      f.emit({ kind: "connecting", attempt: 0 });
      f.emit({ kind: "ready", hello: f.hello });
      return f.hello;
    });
    await expect(f.run()).resolves.toMatchObject({ status: "completed" });
    expect(embedded.run).toHaveBeenCalledOnce();
    expect(embedded.run.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });
});
