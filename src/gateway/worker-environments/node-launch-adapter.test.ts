import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../../infra/node-commands.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "../../node-host/node-worker-supervisor.test-support.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorReceipt,
} from "../../worker/node-supervisor-protocol.js";
import { measureWorkerProcessTurnBytes } from "../../worker/worker-process-protocol.js";
import { buildNodeInvokeRequest, serializeNodeEvent } from "../node-invoke-request.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import {
  createNodeWorkerLaunchAdapter,
  measureNodeWorkerLaunchBytes,
  nodeWorkerSpawnResultFromReceipt,
} from "./node-launch-adapter.js";
import { registerNodeLaunchAdapterNativeInferenceSuite } from "./node-launch-adapter.native-inference.suite.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";

const DEVICE_ID = "device-session-host";
const COMPLETED_RESULT = JSON.stringify({
  status: "completed",
  transcriptLeafId: "leaf-1",
  transcriptNextSeq: 2,
});
const invokeMock = vi.fn<NodeWorkerSupervisorTransport["invoke"]>;

function nodeProof(connId = "conn-1", available = 2): NodeWorkerSupervisorNodeProof {
  return createNodeWorkerBundleTestNode({
    nodeId: DEVICE_ID,
    connId,
    pairingIdentity: "identity-1",
    workerHost: {
      enabled: true,
      capacity: { total: 2, available },
      environmentSession: 1,
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["system.run"],
  });
}

function launchInput(): NodeWorkerLaunchInput {
  const input = testWorkerLaunchInput(
    "/tmp/openclaw-worker/workspace",
    "turn-1",
    "Inspect the workspace.",
  );
  input.descriptor.admission.credential = "worker-fixture-value";
  input.descriptor.assignment.suppressPromptTranscript = true;
  return input;
}

function receipt(
  input: NodeWorkerLaunchInput,
  state: NodeWorkerSupervisorReceipt["state"],
): NodeWorkerSupervisorReceipt {
  const identity = testNodeWorkerLaunchIdentity(input);
  if (state === "completed") {
    return { ...identity, state, resultJson: COMPLETED_RESULT };
  }
  if (state === "failed" || state === "interrupted" || state === "cancelled") {
    return { ...identity, state, errorText: `worker ${state}` };
  }
  return { ...identity, state };
}

function wire(payload: NodeWorkerSupervisorReceipt | null) {
  return { ok: true, payloadJSON: JSON.stringify(payload) };
}

function wireError(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

it.each(["interrupted", "failed", "cancelled"] as const)(
  "preserves the supervisor's %s cause without inferring node loss from diagnostics",
  (state) => {
    const terminal = { ...receipt(launchInput(), state), state, errorText: "same diagnostic" };
    const result = nodeWorkerSpawnResultFromReceipt(terminal);
    expect(result).toMatchObject({
      code: 1,
      stderr: "same diagnostic",
      ...(state === "interrupted" ? { nodeLoss: { code: "node-lost" } } : {}),
    });
    if (state !== "interrupted") {
      expect(result).not.toHaveProperty("nodeLoss");
    }
  },
);

function admissionDeadlineReceipt(input: NodeWorkerLaunchInput): NodeWorkerSupervisorReceipt {
  return {
    ...receipt(input, "completed"),
    state: "completed",
    resultJson: JSON.stringify({
      status: "not-started",
      reason: "admission-deadline",
      errorText: "gateway unreachable",
    }),
  };
}

type AdapterOptions = Omit<Parameters<typeof createNodeWorkerLaunchAdapter>[0], "getTransport"> & {
  nodes?: NodeWorkerSupervisorTransport["listCurrentNodes"];
};
function adapterFor(invoke: NodeWorkerSupervisorTransport["invoke"], options: AdapterOptions = {}) {
  const { nodes: listCurrentNodes = async () => [nodeProof()], ...timing } = options;
  return createNodeWorkerLaunchAdapter({
    getTransport: () => ({
      invoke,
      isCurrent: () => true,
      getCurrentNode: async (nodeId) =>
        (await listCurrentNodes()).find((node) => node.nodeId === nodeId),
      listCurrentNodes,
      hasCurrentRunner: () => true,
    }),
    ...timing,
  });
}

function expectCommands(invoke: ReturnType<typeof invokeMock>, commands: string[]) {
  expect(invoke.mock.calls.map(([request]) => request.command)).toEqual(
    commands.map((name) => `worker.${name}.v1`),
  );
}

describe("node worker launch adapter", () => {
  let input: NodeWorkerLaunchInput;
  let controller: AbortController;
  let invoke: ReturnType<typeof invokeMock>;
  let adapter: ReturnType<typeof adapterFor>;
  const configure = (options: AdapterOptions) => {
    adapter = adapterFor(invoke, options);
  };
  beforeEach(() => {
    input = launchInput();
    controller = new AbortController();
    invoke = invokeMock();
    adapter = adapterFor(invoke);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });
  type LaunchOptions = Partial<Parameters<ReturnType<typeof adapterFor>["launch"]>[0]>;
  const launch = (overrides: LaunchOptions = {}) =>
    adapter.launch({
      deviceId: DEVICE_ID,
      input,
      isDispatchAuthorized: () => true,
      isCancellationAuthorized: () => true,
      timeoutMs: 10_000,
      ...overrides,
    });
  type Request = Parameters<NodeWorkerSupervisorTransport["invoke"]>[0];
  type Reply = ReturnType<typeof wire | typeof wireError>;
  const replyAfterDispatch = (
    reply: (request: Request) => Reply | Promise<Reply>,
    cancel: (request: Request) => Reply | Promise<Reply> = () => wire(receipt(input, "cancelled")),
  ) => {
    invoke.mockImplementation(async (request) => {
      if (request.command === "worker.cancel.v1") {
        return cancel(request);
      }
      request.onDispatchReady?.("invoke-1");
      return reply(request);
    });
  };

  it("hands dispatched turns to restart recovery without remote cancellation", async () => {
    const interruption = createAgentRunRestartAbortError();
    invoke.mockImplementation(async (request) => {
      if (request.command === "worker.cancel.v1") {
        throw new Error("stopping Gateway cannot confirm remote cancellation");
      }
      request.onDispatchReady?.("invoke-shutdown");
      markGatewayRestartDraining();
      controller.abort(interruption);
      resetGatewayWorkAdmission();
      throw interruption;
    });
    await expect(launch({ signal: controller.signal })).rejects.toBe(interruption);
    expectCommands(invoke, ["launch"]);
  });
  it.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    "negotiates retention for node=%s bundle=%s without mutating caller options",
    async (nodeSupports, bundleSupports) => {
      if (!bundleSupports) {
        input.descriptor.admission.handshake.protocolFeatures =
          input.descriptor.admission.handshake.protocolFeatures.filter(
            (feature) => feature !== NODE_WORKER_IDLE_RETENTION_PROTOCOL_FEATURE,
          );
      }
      const node = nodeProof();
      if (nodeSupports) {
        node.workerHost.idleRetention = true;
      }
      const expected = {
        ...structuredClone(input),
        ...(nodeSupports && bundleSupports ? { idleRetention: true as const } : {}),
      };
      invoke.mockImplementation(async (request) => {
        expect(request.params).toEqual(expected);
        return wire(receipt(expected, "completed"));
      });
      configure({ nodes: async () => [node] });
      expect(await launch()).toEqual(receipt(expected, "completed"));
      expect(input).not.toHaveProperty("idleRetention");
    },
  );

  registerNodeLaunchAdapterNativeInferenceSuite();

  it.each([
    [0, false, 60_000, undefined],
    [2, false, 60_000, undefined],
    [2, true, 60_000, 20_000],
    [2, true, 500, 375],
  ] as const)(
    "completes with %s slots, status wait %s, and budget %s",
    async (available, supported, timeoutMs, waitMs) => {
      const node = nodeProof("conn-1", available);
      if (supported) {
        node.workerHost.statusWait = 1;
      }
      const sleep = vi.fn(async () => {});
      invoke.mockImplementation(async (request) => {
        if (request.command === "worker.launch.v1") {
          node.workerHost.capacity.available = 0;
          return wire(receipt(input, available === 0 ? "completed" : "running"));
        }
        expect(request.command).toBe("worker.status.v1");
        expect(request.params).toEqual({
          launchId: input.launchId,
          ...(supported ? { waitMs } : {}),
        });
        return wire(receipt(input, "completed"));
      });
      configure({ nodes: async () => [node], sleep, now: () => 0 });
      await expect(launch({ timeoutMs })).resolves.toEqual(receipt(input, "completed"));
      expect(sleep).toHaveBeenCalledTimes(supported || available === 0 ? 0 : 1);
      expectCommands(invoke, available === 0 ? ["launch"] : ["launch", "status"]);
    },
  );

  it.each(["disconnect", "RPC timeout", "missing receipt", "older replacement"] as const)(
    "reacquires the node and replays the launch after %s",
    async (recovery) => {
      let node = nodeProof();
      if (recovery === "older replacement") {
        node.workerHost.statusWait = 1;
      }
      let launches = 0;
      let discoveries = 0;
      if (recovery === "RPC timeout") {
        vi.useFakeTimers();
      }
      invoke.mockImplementation(async (request) => {
        if (request.command === "worker.launch.v1") {
          expect(request.params).toEqual(input);
          request.onDispatchReady?.(`invoke-${++launches}`);
          if (recovery === "RPC timeout" && launches === 1) {
            return await new Promise<never>(() => {});
          }
          if (recovery === "disconnect" && launches === 1) {
            return wireError("DISCONNECTED", "node disconnected");
          }
          return wire(
            receipt(
              input,
              recovery === "older replacement" || (recovery === "missing receipt" && launches === 1)
                ? "running"
                : "completed",
            ),
          );
        }
        expect(request.command).toBe("worker.status.v1");
        if (recovery === "older replacement" && launches === 1) {
          expect(request.params).toHaveProperty("waitMs");
          node = nodeProof("older-replacement");
          return wireError("DISCONNECTED", "connection replaced");
        }
        expect(request.params).toEqual({ launchId: input.launchId });
        return wire(recovery === "missing receipt" ? null : receipt(input, "completed"));
      });
      configure({
        nodes: async () => [recovery === "disconnect" ? nodeProof(`conn-${++discoveries}`) : node],
        sleep: async () => {},
      });
      const result = expect(
        launch(recovery === "RPC timeout" ? { timeoutMs: 90_000, signal: controller.signal } : {}),
      ).resolves.toEqual(receipt(input, "completed"));
      if (recovery === "RPC timeout") {
        await vi.advanceTimersByTimeAsync(29_999);
        expect(launches).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
      }
      await result;
      expectCommands(
        invoke,
        recovery === "disconnect" || recovery === "RPC timeout"
          ? ["launch", "launch"]
          : ["launch", "status", "launch", ...(recovery === "older replacement" ? ["status"] : [])],
      );
      if (recovery === "disconnect") {
        expect(invoke.mock.calls.map(([call]) => call.node.connId)).toEqual(["conn-1", "conn-2"]);
      }
    },
  );

  it("re-arms settled admission deadlines with bounded, idempotent launch identities", async () => {
    input.descriptor.assignment.systemPrompt = '"\\\0\n漢😀'.repeat(10_000);
    input.descriptor.assignment.systemPrompt += "x".repeat(
      WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES - measureNodeWorkerLaunchBytes(DEVICE_ID, input),
    );
    const bound = measureNodeWorkerLaunchBytes(DEVICE_ID, input);
    expect(bound).toBe(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
    const launches: NodeWorkerLaunchInput[] = [];
    const delays: number[] = [];
    invoke.mockImplementation(async (request) => {
      const attempt = request.params as NodeWorkerLaunchInput;
      const frameBytes = Buffer.byteLength(
        serializeNodeEvent(
          "node.invoke.request",
          buildNodeInvokeRequest({
            id: "00000000-0000-0000-0000-000000000000",
            nodeId: request.node.nodeId,
            command: request.command,
            params: attempt,
            timeoutMs: request.timeoutMs!,
            idempotencyKey: request.idempotencyKey,
          }),
        ),
      );
      expect(frameBytes).toBeLessThanOrEqual(bound);
      expect(measureWorkerProcessTurnBytes(attempt.descriptor)).toBeLessThanOrEqual(bound);
      launches.push(attempt);
      return wire(
        launches.length === 1 ? admissionDeadlineReceipt(attempt) : receipt(attempt, "completed"),
      );
    });
    configure({
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(
      launch({ credentialExpiresAtMs: Date.now() + 10 * 60_000 }),
    ).resolves.toMatchObject({
      resultJson: COMPLETED_RESULT,
    });
    expect(launches).toHaveLength(2);
    expect(launches[1]?.launchId).not.toBe(input.launchId);
    expect(launches[1]?.descriptor.assignment.turnId).toBe(launches[1]?.launchId);
    expect(launches[1]?.descriptor.assignment.runId).toBe(input.descriptor.assignment.runId);
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays[0]).toBeLessThanOrEqual(1_100);
  });

  it.each([
    { bound: "credential expiry", credentialLifetimeMs: 121_500, attempts: 2 },
    { bound: "attempt limit", credentialLifetimeMs: undefined, attempts: 5 },
  ])("bounds admission re-arms by $bound", async ({ credentialLifetimeMs, attempts }) => {
    const nowMs = 1_700_000_000_000;
    invoke.mockImplementation(async (request) =>
      wire(admissionDeadlineReceipt(request.params as NodeWorkerLaunchInput)),
    );
    configure({
      now: () => nowMs,
      sleep: async () => {},
    });
    // The first backoff fits 1,500ms of credential headroom; the second cannot.
    const result = await launch(
      credentialLifetimeMs === undefined
        ? {}
        : { credentialExpiresAtMs: nowMs + credentialLifetimeMs },
    );
    expect(invoke).toHaveBeenCalledTimes(attempts);
    if (result.state !== "completed") {
      throw new Error("expected a completed admission failure");
    }
    expect(JSON.parse(result.resultJson)).toMatchObject({ reason: "admission-deadline" });
    expect(
      new Set(
        invoke.mock.calls.map(([request]) => (request.params as NodeWorkerLaunchInput).launchId),
      ).size,
    ).toBe(attempts);
  });

  it("does not re-arm terminal rejection text that resembles an admission deadline", async () => {
    const errorText = "admission deadline exceeded";
    const terminal = { ...receipt(input, "failed"), state: "failed" as const, errorText };
    invoke.mockResolvedValue(wire(terminal));
    await expect(launch()).resolves.toEqual(terminal);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(["abort", "claim-loss"])(
    "fences admission re-arm after %s during backoff",
    async (reason) => {
      let authorized = true;
      invoke.mockResolvedValue(wire(admissionDeadlineReceipt(input)));
      configure({
        sleep: async () => {
          if (reason === "abort") {
            controller.abort(new Error("turn cancelled"));
          } else {
            authorized = false;
          }
        },
      });
      await expect(
        launch({ signal: controller.signal, isDispatchAuthorized: () => authorized }),
      ).rejects.toThrow(reason === "abort" ? "turn cancelled" : "authority closed");
      expect(invoke).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["timer expiry", false, 30_000, false, { code: "runner-offline" }],
    ["shorter launch deadline", true, 5_000, false, { message: "node worker launch timed out" }],
    ["caller cancellation", true, 30_000, true, { message: "caller cancelled" }],
    ["stalled discovery", false, 25, false, { message: "node worker launch timed out" }],
  ] as const)(
    "preserves pre-dispatch failure identity after %s",
    async (name, clockOnly, timeoutMs, abort, expected) => {
      vi.useFakeTimers();
      let nowMs = 0;
      const onDispatchReady = vi.fn();
      configure({
        nodes: async () => (name === "stalled discovery" ? await new Promise<never>(() => {}) : []),
        ...(clockOnly
          ? {
              now: () => nowMs,
              sleep: async () => {
                nowMs += 10_000;
                if (abort) {
                  controller.abort(new Error("caller cancelled"));
                }
              },
            }
          : {}),
      });
      const pending = launch({ timeoutMs, onDispatchReady, signal: controller.signal });
      const failure = expect(pending).rejects.toMatchObject(expected);
      if (!clockOnly) {
        await vi.runAllTimersAsync();
      }
      await failure;
      expect(invoke).not.toHaveBeenCalled();
      expect(onDispatchReady).not.toHaveBeenCalled();
    },
  );

  it.each(["environmentSession", "capturedExecPolicy", "promptContext"] as const)(
    "requires %s support before dispatching a turn",
    async (feature) => {
      const node = nodeProof();
      delete node.workerHost[feature];
      configure({ nodes: async () => [node] });

      await expect(launch()).rejects.toMatchObject({
        code: "node_runner_update_required",
        message: expect.stringContaining("openclaw update"),
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("fails exhausted capacity without retrying or cancelling", async () => {
    let nowMs = 0;
    replyAfterDispatch(() =>
      wireError(NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE, "capacity exhausted"),
    );
    configure({
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });

    await expect(launch()).rejects.toMatchObject({
      code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      message: "device worker capacity remained full",
    });
    expectCommands(invoke, ["launch"]);
    expect(nowMs).toBe(0);
  });

  it("cancels an invalid launch replay when an earlier dispatch may have registered it", async () => {
    const launchResponses = [
      wireError("TIMEOUT", "node invoke timed out"),
      wireError("INVALID_REQUEST", "INVALID_REQUEST: node placement workspace is being removed"),
    ];
    replyAfterDispatch(() => launchResponses.shift()!);
    configure({ sleep: async () => {} });

    await expect(launch()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expectCommands(invoke, ["launch", "launch", "cancel"]);
  });

  it("cancels before rejecting a post-dispatch identity mismatch", async () => {
    const mismatched = { ...receipt(input, "completed"), environmentId: "environment-other" };
    replyAfterDispatch(() => wire(mismatched));
    await expect(launch()).rejects.toThrow("node worker supervisor receipt identity mismatch");
    expectCommands(invoke, ["launch", "cancel"]);
  });

  it.each(["launch", "status", "cancel"] as const)(
    "preserves the command and bounded, redacted node rejection when %s fails",
    async (failedCommand) => {
      const secret = "synthetic-worker-launch-secret-value";
      const rejection = "INVALID_REQUEST: prepared workspace binding is missing";
      const wireRejection = `${rejection} token=${secret}\n${"x".repeat(2_048)}; field assignment is invalid`;
      const cancellationRejection = "INVALID_REQUEST: cancellation identity is invalid";
      replyAfterDispatch(
        (request) =>
          request.command === "worker.launch.v1" && failedCommand !== "launch"
            ? wire(receipt(input, "running"))
            : wireError("INVALID_REQUEST", wireRejection),
        () =>
          failedCommand === "cancel"
            ? wireError("INVALID_REQUEST", cancellationRejection)
            : wire(receipt(input, "cancelled")),
      );
      configure({ sleep: async () => {} });

      const error: unknown = await launch().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected a launch error");
      }
      const diagnostic = formatErrorMessage(error);
      expect(diagnostic).toContain(rejection);
      expect(diagnostic).toContain("field assignment is invalid");
      expect(error.message).not.toContain(secret);
      expect(diagnostic).toContain(`worker.${failedCommand}.v1`);
      if (failedCommand === "cancel") {
        expect(diagnostic).toContain(cancellationRejection);
        expect(diagnostic).toContain("cancellation could not be confirmed");
      } else {
        expect(error.message).not.toContain("\n");
        expect(error.message.length).toBeLessThanOrEqual(1_024);
      }
      expectCommands(
        invoke,
        failedCommand === "launch" ? ["launch"] : ["launch", "status", "cancel"],
      );
    },
  );

  it.each([
    "hosting withdrawn",
    "unsettled receipts",
    "dispatch authority closed",
    "status wait",
  ] as const)("settles cancellation with independent authority after %s", async (cause) => {
    let launched = false;
    let dispatchAuthorized = true;
    const cancelAuthorized = vi.fn(() => true);
    const sleep = vi.fn(async () => {
      if (cause === "dispatch authority closed") {
        dispatchAuthorized = false;
      } else {
        controller.abort();
      }
    });
    const cancelResponses =
      cause === "unsettled receipts"
        ? [wire(null), wire(receipt(input, "running")), wire(receipt(input, "cancelled"))]
        : [wire(receipt(input, "cancelled"))];
    invoke.mockImplementation(async (request) => {
      if (request.command === "worker.cancel.v1") {
        expect(request.isDispatchAuthorized()).toBe(true);
        expect(request.params).toMatchObject({
          launchId: input.launchId,
          planHash: nodeWorkerPlanHash(input),
        });
        return cancelResponses.shift()!;
      }
      if (cause === "status wait" && request.command === "worker.status.v1") {
        expect(request.params).toHaveProperty("waitMs");
        return await new Promise<never>((_, reject) => {
          const cancellation = new Error("status wait cancelled");
          request.signal?.addEventListener("abort", () => reject(cancellation), { once: true });
          queueMicrotask(() => controller.abort(cancellation));
        });
      }
      launched = true;
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    configure({
      nodes: async () => {
        const node = nodeProof("conn-1", launched && cause === "hosting withdrawn" ? 0 : 2);
        if (cause === "status wait") {
          node.workerHost.statusWait = 1;
        }
        return [node];
      },
      sleep,
    });

    await expect(
      launch({
        signal: controller.signal,
        isDispatchAuthorized: () => dispatchAuthorized,
        isCancellationAuthorized: cancelAuthorized,
      }),
    ).resolves.toEqual(receipt(input, "cancelled"));
    expect(cancelAuthorized).toHaveBeenCalled();
    if (cause === "status wait") {
      expect(sleep).not.toHaveBeenCalled();
      expectCommands(invoke, ["launch", "status", "cancel"]);
    }
    expect(
      invoke.mock.calls.filter(([request]) => request.command === "worker.cancel.v1"),
    ).toHaveLength(cause === "unsettled receipts" ? 3 : 1);
    expect(invoke.mock.calls.at(-1)?.[0].node.workerHost.capacity).toEqual({
      total: 2,
      available: cause === "hosting withdrawn" ? 0 : 2,
    });
  });

  it("reports unknown cancellation outcome after a hard cancellation deadline", async () => {
    vi.useFakeTimers();
    replyAfterDispatch(
      () => wire(receipt(input, "running")),
      () => new Promise<never>(() => {}),
    );
    // Clock/timer lag must not fund a second cancellation RPC after the hard deadline.
    let cancelling = false;
    let cancelClockReads = 0;
    configure({
      now: () => Date.now() + (cancelling && ++cancelClockReads === 3 ? 5 : 0),
      sleep: async () => {
        controller.abort();
        cancelling = true;
      },
    });

    const pending = launch({ signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const failure: unknown = await pending;
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = formatErrorMessage(failure);
    expect(diagnostic).toContain(
      "node worker launch failed and cancellation could not be confirmed",
    );
    expect(diagnostic).toContain(
      "node worker cancellation did not produce a terminal receipt before its deadline",
    );
    expect(
      invoke.mock.calls.filter(([request]) => request.command === "worker.cancel.v1"),
    ).toHaveLength(1);
  });
});
