import { afterEach, expect, it, vi } from "vitest";
import type { WorkerHelloOk } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareCoreToolPolicy } from "../agents/prepared-tool-surface.js";
import { completionModel } from "../agents/simple-completion.test-support.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import {
  testWorkerLaunchInput,
  TEST_WORKER_ENDPOINT,
} from "../node-host/node-worker-supervisor.test-support.js";
import { parseWorkerLaunchDescriptor, buildWorkerConnectParams } from "./launch-descriptor.js";
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
// mock-isolation: this gate must replace the runtime module to hold its import before execution.
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

type Step = "ready" | "stopped" | ["connecting" | "admitting" | "reconnecting", number];
function fixture(native = true, steps: Step[] = ["ready"]) {
  const root = tempDirs.make("native-admission-authority-");
  const descriptor = parseWorkerLaunchDescriptor({
    ...testWorkerLaunchInput(root, "authority-turn").descriptor,
    connectionEndpoint: TEST_WORKER_ENDPOINT,
  });
  if (native) {
    descriptor.assignment.inference = "runtime-local";
  }
  const ref = descriptor.assignment.modelRef;
  const model = completionModel({
    provider: ref.provider,
    id: ref.model,
    api: "openai-completions",
    baseUrl: "https://model.example.test/v1",
  });
  const startup: NativeInferenceStartup = {
    credentials: { [`${ref.provider}/${ref.model}`]: "synthetic-authority-key" },
    config: { models: [{ ...model, contextWindow: 8192 }], workspace: root },
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
    return () => void listeners.delete(listener);
  });
  vi.spyOn(connections, "createWorkerConnection").mockReturnValue(connection);
  const emit = (step: Step) => {
    state =
      step === "ready"
        ? { kind: step, hello }
        : step === "stopped"
          ? { kind: step }
          : { kind: step[0], attempt: step[1] };
    listeners.forEach((listener) => listener(state));
  };
  const hello: WorkerHelloOk = {
    type: "worker-hello-ok",
    environmentId: descriptor.admission.environmentId,
    sessionId: descriptor.admission.sessionId,
    ownerEpoch: descriptor.admission.ownerEpoch,
    rpcSetVersion: descriptor.admission.rpcSetVersion,
    protocolFeatures: descriptor.admission.handshake.protocolFeatures,
    toolSurface: {
      generation: "authority-fixture",
      presentation: createToolSurfacePresentationForTest(),
      tools: [],
      policy: prepareCoreToolPolicy({}),
    },
    credentialExpiresAtMs: Date.now() + 60000,
    policy: { heartbeatIntervalMs: 60000, maxPayload: 1024 * 1024 },
  };
  vi.spyOn(connection, "start").mockImplementation(async () => {
    steps.forEach(emit);
    return hello;
  });
  const run = () =>
    runWorkerDescriptor(descriptor, {
      environmentStateDir: root,
      ...(native ? { nativeInference: startup } : {}),
    });
  return { emit, run };
}

it("latches authority loss while runtime imports are still awaited before the turn starts", async () => {
  const f = fixture();
  const running = f.run().catch((error: unknown) => error);
  try {
    await embedded.entered.promise;
    f.emit(["connecting", 0]);
    f.emit("ready");
  } finally {
    embedded.release.resolve();
  }
  expect(await running).toMatchObject({ status: "failed", reason: "node-lost" });
  expect(embedded.run).not.toHaveBeenCalled();
});
const retries: Step[] = [
  ["connecting", 0],
  ["admitting", 0],
  ["reconnecting", 1],
  ["connecting", 1],
  "ready",
];
it.each([
  [true, ["ready", ["connecting", 0], "ready"], "failed"],
  [true, ["ready", ["admitting", 0], "ready"], "failed"],
  [true, ["ready", ["reconnecting", 0], "ready"], "failed"],
  [true, ["ready", "stopped", "ready"], "failed"],
  [true, retries, "completed"],
  [false, retries, "completed"],
  [false, ["ready", ["connecting", 0], "ready"], "completed"],
] satisfies [boolean, Step[], "failed" | "completed"][])(
  "preserves admission lifetime native=%s, transitions=%j, status=%s",
  async (native, steps, status) => {
    await expect(fixture(native, steps).run()).resolves.toMatchObject(
      status === "failed" ? { status, reason: "node-lost" } : { status },
    );
    expect(embedded.run).toHaveBeenCalledTimes(status === "failed" ? 0 : 1);
    if (status === "completed") {
      expect(embedded.run.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    }
  },
);
