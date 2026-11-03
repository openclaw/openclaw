import { once } from "node:events";
import path from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND as STOP_ENVIRONMENT,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND as CANCEL_LAUNCH,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND as LAUNCH,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND as READ_STATUS,
} from "../../infra/node-commands.js";
import { resolveNodeWorkerLaunchToolNames } from "../../infra/node-runner-inventory.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runWithProcessCleanupBudget } from "../../process/supervisor/cleanup-budget.js";
import {
  nodeWorkerPlanHash,
  parseNodeWorkerEnvironmentStopInput,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorReceipt,
} from "../../worker/node-supervisor-protocol.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND as DRAIN_WORKSPACE,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import {
  createNodeWorkerLaunchAdapter,
  measureNodeWorkerLaunchBytes,
} from "./node-launch-adapter.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import {
  createManager as createTunnelManager,
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceTransfer,
  workspaceReply,
  tunnelLaunchPlan as plan,
} from "./node-worker-tunnel.test-support.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

type NodeWorkerLaunch = ReturnType<typeof createNodeWorkerLaunchAdapter>["launch"];
type TerminalReceipt = Awaited<ReturnType<NodeWorkerLaunch>>;
let record: ReturnType<typeof environment>;
let nodeTransport: NodeWorkerSupervisorTransport;
let transfer: ReturnType<typeof workspaceTransfer>;
beforeEach(() => {
  record = environment();
  nodeTransport = transport();
  transfer = workspaceTransfer();
});
function enableTransferCleanup() {
  transfer.closeAll = vi.fn(async () => {});
}
function createManager(overrides: Parameters<typeof createTunnelManager>[1] = {}) {
  return createTunnelManager(record, {
    getTransport: () => nodeTransport,
    workspaceTransfer: transfer,
    ...overrides,
  });
}
async function currentNodeHost() {
  const nodes = await nodeTransport.listCurrentNodes();
  nodeTransport.listCurrentNodes = async () => nodes;
  return nodes[0]!.workerHost;
}
async function expectPending(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await nextImmediate();
  expect(settled).not.toHaveBeenCalled();
}
const nullReply = { ok: true, payloadJSON: "null" };
const drainReply = () => workspaceReply("/node/workspace", { stdout: "drained\n" });

function receiptIdentity(input: NodeWorkerLaunchInput, planHash = "b".repeat(64)) {
  return {
    launchId: input.launchId,
    planHash,
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
  };
}

function cancelledReceipt({ input }: Parameters<NodeWorkerLaunch>[0]): TerminalReceipt {
  return { ...receiptIdentity(input), state: "cancelled", errorText: "node worker cancelled" };
}
function completedReceipt(input: NodeWorkerLaunchInput, planHash?: string): TerminalReceipt {
  return {
    ...receiptIdentity(input, planHash),
    state: "completed",
    resultJson: '{"status":"completed"}',
  };
}
const supervisorReply = (receipt: NodeWorkerSupervisorReceipt) => ({
  ok: true,
  payloadJSON: JSON.stringify(receipt),
});

function launchTurn(
  handle: Awaited<ReturnType<ReturnType<typeof createTunnelManager>["start"]>>,
  overrides: Partial<Parameters<typeof handle.launchTurn>[0]> = {},
) {
  const launchPlan = overrides.plan ?? plan();
  return handle.launchTurn({ plan: launchPlan, turnClaim: turnClaim(launchPlan), ...overrides });
}

function workspaceTransport(
  workspace: NodeWorkerWorkspaceRuntime,
  onCommand: (request: Parameters<NodeWorkerSupervisorTransport["invoke"]>[0]) => void,
) {
  return {
    ...transport(),
    invoke: async (request) => {
      onCommand(request);
      if (request.command === STOP_ENVIRONMENT) {
        await workspace.processes.stopEnvironment(
          parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params)),
        );
        return nullReply;
      }
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
      return { ok: true, payloadJSON: JSON.stringify(await workspace.exec(input, request.signal)) };
    },
  } satisfies NodeWorkerSupervisorTransport;
}

function turnClaim(launchPlan = plan()) {
  return {
    sessionId: launchPlan.admission.sessionId,
    claimId: "claim-1",
    runId: launchPlan.assignment.runId,
    placementGeneration: 4,
    owner: {
      kind: "worker" as const,
      environmentId: launchPlan.admission.environmentId,
      ownerEpoch: launchPlan.admission.ownerEpoch,
    },
  };
}

describe("node worker tunnel lifetime", () => {
  it("joins supported workspace drain when the node cannot stop its environment", async ({
    signal,
  }) => {
    enableTransferCleanup();
    delete (await currentNodeHost()).environmentSession;
    const entered = createDeferred();
    const release = createDeferred();
    nodeTransport.invoke = async (request) => {
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
      expect(input.argv).toEqual([DRAIN_WORKSPACE]);
      entered.resolve();
      await release.promise;
      return drainReply();
    };
    const manager = createManager();
    const stopping = manager.stopAll().catch((error: unknown) => error);
    try {
      expect(
        await withinTest(
          Promise.race([entered.promise.then(() => "drain"), stopping.then(() => "stopped")]),
          signal,
        ),
      ).toBe("drain");
      expect(transfer.close).not.toHaveBeenCalled();
      release.resolve();
      expect(await stopping).toMatchObject({ code: "node_runner_update_required" });
      expect(transfer.close).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await stopping;
    }
  });

  it.each([3_000, 30_000])(
    "shares the %i ms shutdown budget across remote stop and drain without renewing it",
    async (budgetMs) => {
      const closeAll = vi.fn(async () => {});
      transfer.closeAll = closeAll;
      vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
      const stopEntered = createDeferred();
      const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
        const timeoutMs = request.timeoutMs;
        if (timeoutMs === undefined) {
          throw new Error("Expected bounded workspace cleanup");
        }
        if (request.command === STOP_ENVIRONMENT) {
          stopEntered.resolve();
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
          return nullReply;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, timeoutMs);
        });
        return { ok: false, error: { code: "TIMEOUT", message: "Node is unavailable" } };
      });
      nodeTransport.invoke = invoke;
      const manager = createManager();
      const stopWithin = (ms: number) =>
        runWithProcessCleanupBudget({ deadline: performance.now() + ms, warn: vi.fn() }, () => {
          manager.beginClose();
          return manager.stopAll();
        });
      let stopped = false;
      const stopping = stopWithin(budgetMs).catch((error: unknown) => {
        stopped = true;
        return error;
      });
      try {
        await stopEntered.promise;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
          STOP_ENVIRONMENT,
          "worker.workspace.exec.v1",
        ]);
        const boundedMs = Math.min(5_000, budgetMs);
        await vi.advanceTimersByTimeAsync(boundedMs - 1_001);
        expect(stopped).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(stopped).toBe(true);
        expect(await stopping).toBeInstanceOf(WorkerTunnelOwnerDisconnectedError);
        expect(closeAll).toHaveBeenCalledOnce();
        await expect(stopWithin(30_000)).rejects.toBeInstanceOf(WorkerTunnelOwnerDisconnectedError);
        expect(invoke).toHaveBeenCalledTimes(2);
      } finally {
        await vi.advanceTimersByTimeAsync(60_000);
        await stopping;
        vi.useRealTimers();
      }
    },
  );

  it("keeps the original shutdown deadline after a failed cleanup attempt", async () => {
    enableTransferCleanup();
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const manager = createManager();
    const failure = new Error("Node cleanup failed before acknowledging stop");
    nodeTransport.invoke = withWorkspaceDrain(async () => {
      throw failure;
    });
    const entered = createDeferred();
    const release = createDeferred();
    let retry: Promise<unknown> | undefined;
    try {
      manager.beginClose();
      await expect(manager.stopAll()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(2_000);
      nodeTransport.invoke = withWorkspaceDrain(async () => {
        entered.resolve();
        await release.promise;
        return nullReply;
      });
      let stopped = false;
      retry = manager.stopAll().catch((error: unknown) => {
        stopped = true;
        return error;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(stopped).toBe(true);
      expect(await retry).toBeInstanceOf(WorkerTunnelOwnerDisconnectedError);
    } finally {
      release.resolve();
      await retry;
      vi.useRealTimers();
    }
  });

  it("bounds already-cancelling active turns at shutdown while retaining transfer settlement", async () => {
    const records = [
      record,
      { ...record, environmentId: "environment-2", attachedSessionIds: ["session-2"] },
    ];
    const statusesEntered = createDeferred();
    const cancellationsEntered = createDeferred();
    const remoteRelease = createDeferred();
    const transferRelease = createDeferred();
    const host = await currentNodeHost();
    host.capturedExecPolicy = true;
    host.promptContext = 1;
    let statusCount = 0;
    let cancellationCount = 0;
    nodeTransport.invoke = withWorkspaceDrain(async (request) => {
      if (request.command === LAUNCH) {
        const input = request.params as NodeWorkerLaunchInput;
        request.onDispatchReady?.("launch-invoke");
        return supervisorReply({
          ...receiptIdentity(input, nodeWorkerPlanHash(input)),
          state: "running",
        });
      }
      if (request.command === READ_STATUS && ++statusCount === records.length) {
        statusesEntered.resolve();
      }
      if (request.command === CANCEL_LAUNCH && ++cancellationCount === records.length) {
        cancellationsEntered.resolve();
      }
      // The remote owner never acknowledges cancellation or environment stop.
      await remoteRelease.promise;
      return nullReply;
    });
    transfer.close = vi.fn(async () => await transferRelease.promise);
    const closeAll = vi.fn(async () => {});
    transfer.closeAll = closeAll;
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => nodeTransport,
      sleep: async () => {},
    });
    const manager = createManager({
      getEnvironment: (id) => records.find((entry) => entry.environmentId === id),
      listEnvironments: () => records,
      launchNodeWorker: adapter.launch,
    });
    const controllers = records.map(() => new AbortController());
    const launchSettled = vi.fn();
    const launches: Promise<unknown>[] = [];
    let stopping: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      for (const [index, currentEnvironment] of records.entries()) {
        const sessionId = currentEnvironment.attachedSessionIds[0]!;
        const handle = await manager.start({
          ...startRequest(),
          environmentId: currentEnvironment.environmentId,
          sessionId,
        });
        const launchPlan = plan();
        launchPlan.admission.environmentId = currentEnvironment.environmentId;
        launchPlan.admission.sessionId = sessionId;
        launchPlan.admission.ownerEpoch = currentEnvironment.ownerEpoch;
        launchPlan.assignment.turnId = `turn-${index + 1}`;
        launchPlan.assignment.runId = `run-${index + 1}`;
        launches.push(
          launchTurn(handle, { plan: launchPlan, signal: controllers[index]!.signal }).then(
            launchSettled,
            (error: unknown) => {
              launchSettled();
              return error;
            },
          ),
        );
      }
      await statusesEntered.promise;
      for (const controller of controllers) {
        controller.abort(new Error("active turn cancelled before restart"));
      }
      await cancellationsEntered.promise;
      manager.beginClose();
      const stopSettled = vi.fn();
      stopping = manager.stopAll().then(stopSettled, (error: unknown) => {
        stopSettled();
        return error;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(launchSettled).toHaveBeenCalledTimes(2);
      expect(transfer.close).toHaveBeenCalledTimes(2);
      expect(stopSettled).not.toHaveBeenCalled();
      expect(closeAll).not.toHaveBeenCalled();
      transferRelease.resolve();
      expect(await stopping).toBeInstanceOf(WorkerTunnelOwnerDisconnectedError);
      expect(closeAll).toHaveBeenCalledOnce();
    } finally {
      transferRelease.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      remoteRelease.resolve();
      await Promise.allSettled([...launches, ...(stopping ? [stopping] : [])]);
      vi.useRealTimers();
    }
  });

  it("reads the current destination's launch vocabulary with a legacy fallback while offline", async () => {
    const host = await currentNodeHost();
    let currentTransport: NodeWorkerSupervisorTransport | undefined = nodeTransport;
    const manager = createManager({ getTransport: () => currentTransport });
    const handle = await manager.start(startRequest());
    const legacy = resolveNodeWorkerLaunchToolNames(host);
    await expect(handle.readLaunchToolNames()).resolves.toEqual(legacy);

    for (const names of [[], ["read", "presence"]]) {
      host.launchToolNames = names;
      await expect(handle.readLaunchToolNames()).resolves.toEqual(names);
    }

    nodeTransport.listCurrentNodes = async () => [];
    await expect(handle.readLaunchToolNames()).resolves.toEqual(legacy);
    currentTransport = undefined;
    await expect(handle.readLaunchToolNames()).resolves.toEqual(legacy);
  });

  it("revalidates the exact claim when a same-run replacement launches", async () => {
    let currentClaim = turnClaim();
    const authorizations: boolean[] = [];
    const launchSizes: number[] = [];
    const manager = createManager({
      launchNodeWorker: vi.fn<NodeWorkerLaunch>(async (request) => {
        authorizations.push(request.isDispatchAuthorized());
        launchSizes.push(measureNodeWorkerLaunchBytes(request.deviceId, request.input));
        return { ...cancelledReceipt(request), errorText: "test launch finished" };
      }),
      validateWorkerTurn: (claim) => sameWorkerSessionTurnClaim(claim, currentClaim),
    });
    const handle = await manager.start(startRequest());
    const staleClaim = currentClaim;
    currentClaim = { ...staleClaim, claimId: "claim-2", placementGeneration: 5 };

    const launchPlan = plan();
    const snapshot = structuredClone(launchPlan);
    const sizes = [staleClaim, currentClaim].map((claim) =>
      handle.measureLaunchTurn(launchPlan, claim),
    );
    await handle.launchTurn({ plan: launchPlan, turnClaim: staleClaim });
    await handle.launchTurn({ plan: launchPlan, turnClaim: currentClaim });

    expect(authorizations).toEqual([false, true]);
    expect(launchSizes).toEqual(sizes);
    expect(launchPlan).toEqual(snapshot);
  });

  it("stops an unconfirmed old launch before dispatching its replacement", async () => {
    let currentClaim = turnClaim();
    let firstLaunch = true;
    const stopEntered = createDeferred();
    const stopAck = createDeferred();
    const invoked: string[] = [];
    const host = await currentNodeHost();
    host.capturedExecPolicy = true;
    host.promptContext = 1;
    nodeTransport.invoke = withWorkspaceDrain(async (request) => {
      invoked.push(request.command);
      switch (request.command) {
        case STOP_ENVIRONMENT:
          stopEntered.resolve();
          await stopAck.promise;
          return nullReply;
        case CANCEL_LAUNCH:
          return { ok: false, error: { code: "INVALID_REQUEST" } };
        case READ_STATUS: {
          const signal = request.signal;
          if (!signal) {
            throw new Error("expected node status signal");
          }
          await once(signal, "abort");
          throw signal.reason;
        }
        case LAUNCH: {
          const input = request.params as NodeWorkerLaunchInput;
          request.onDispatchReady?.("launch-invoke");
          const receipt = firstLaunch
            ? { ...receiptIdentity(input, nodeWorkerPlanHash(input)), state: "running" as const }
            : completedReceipt(input, nodeWorkerPlanHash(input));
          firstLaunch = false;
          return supervisorReply(receipt);
        }
        default:
          throw new Error(`unexpected node command: ${request.command}`);
      }
    });
    const launchAdapter = createNodeWorkerLaunchAdapter({
      getTransport: () => nodeTransport,
      sleep: async () => {},
    });
    const manager = createManager({
      launchNodeWorker: launchAdapter.launch,
      validateWorkerTurn: (claim) => sameWorkerSessionTurnClaim(claim, currentClaim),
    });
    const first = await manager.start(startRequest());
    const staleClaim = currentClaim;
    currentClaim = { ...staleClaim, claimId: "claim-2" };

    await expect(launchTurn(first, { turnClaim: staleClaim })).rejects.toThrow("authority closed");
    expect(invoked).toEqual([]);

    const controller = new AbortController();
    const unconfirmed = launchTurn(first, {
      turnClaim: currentClaim,
      signal: controller.signal,
    });
    const unconfirmedRejection = expect(unconfirmed).rejects.toThrow(
      "node worker launch failed and cancellation could not be confirmed",
    );
    await vi.waitFor(() => expect(invoked).toContain(READ_STATUS));
    expect(invoked).toEqual([LAUNCH, READ_STATUS]);
    controller.abort(new Error("turn cancelled"));
    await unconfirmedRejection;

    record.ownerEpoch = 3;
    currentClaim = {
      ...currentClaim,
      claimId: "claim-3",
      placementGeneration: 5,
      owner: { kind: "worker", environmentId: record.environmentId, ownerEpoch: 3 },
    };
    const replacing = manager.start({ ...startRequest(), ownerEpoch: 3 });
    await stopEntered.promise;
    await expectPending(replacing);
    stopAck.resolve();
    const replacement = await replacing;

    const replacementPlan = plan();
    replacementPlan.admission.ownerEpoch = 3;
    await expect(
      replacement.launchTurn({ plan: replacementPlan, turnClaim: currentClaim }),
    ).resolves.toMatchObject({ code: 0 });
    expect(invoked).toEqual([LAUNCH, READ_STATUS, CANCEL_LAUNCH, STOP_ENVIRONMENT, LAUNCH]);
    await manager.stop(record.environmentId, 3, "provider-destroyed");
  });

  it("closes remote-exec workspaces without requiring an embedded worker lifetime command", async () => {
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "remote-exec" };
    delete (await currentNodeHost()).environmentSession;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const manager = createManager();
    const handle = await manager.start({ ...startRequest(), executionMode: "remote-exec" });
    await expect(launchTurn(handle)).rejects.toThrow("remote-exec");
    // Later durable changes cannot widen the retiring handle's process ownership.
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "worker-turn" };
    await handle.stop();
    expect(invoke).not.toHaveBeenCalled();
    expect(transfer.close).toHaveBeenCalledExactlyOnceWith(record.environmentId);
  });

  it("reuses only an exact binding and stops a completed owner before exposing its replacement", async () => {
    const stopped = createDeferred();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      await stopped.promise;
      return nullReply;
    });
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const manager = createManager({
      launchNodeWorker: async (request) => completedReceipt(request.input),
    });
    const first = await manager.start(startRequest());
    await expect(manager.start(startRequest())).resolves.toBe(first);
    await expect(manager.start({ ...startRequest(), sessionId: "session-other" })).rejects.toThrow(
      "binding changed",
    );
    await expect(launchTurn(first)).resolves.toMatchObject({ code: 0 });
    record.ownerEpoch = 3;
    const replacing = manager.start({ ...startRequest(), ownerEpoch: 3 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(manager.status(record.environmentId)).toBe("connecting");
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      command: STOP_ENVIRONMENT,
      params: { environmentId: record.environmentId, sessionId: "session-1", ownerEpoch: 2 },
    });
    stopped.resolve();
    await replacing;
    expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized()).toBe(false);

    await manager.stop(record.environmentId, 2);
    expect(invoke).toHaveBeenCalledOnce();
    expect(manager.status(record.environmentId)).toBe("connected");
    await manager.stop(record.environmentId, 3);
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({ ownerEpoch: 3 });
  });

  it.each(["stop", "stopAll"] as const)(
    "%s recovers exact durable owners after restart and retries an unconfirmed stop",
    async (operation) => {
      enableTransferCleanup();
      record.bootstrapReceipt = null;
      const invoke = vi
        .fn<NodeWorkerSupervisorTransport["invoke"]>()
        .mockResolvedValueOnce({ ok: false, error: { code: "DISCONNECTED" } })
        .mockResolvedValue(nullReply);
      nodeTransport.invoke = withWorkspaceDrain(invoke);
      const manager = createManager();
      const stop = () =>
        operation === "stop" ? manager.stop(record.environmentId, 2) : manager.stopAll();

      await expect(stop()).rejects.toThrow("DISCONNECTED");
      expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized()).toBe(false);
      await stop();
      const owner = expect.objectContaining({
        environmentId: record.environmentId,
        sessionId: "session-1",
        ownerEpoch: 2,
      });
      expect(invoke.mock.calls.map(([request]) => request.params)).toEqual([owner, owner]);
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "fences an unconfirmed workspace command until its %s owner drains after reconnect",
    async (executionMode) => {
      record.profileSnapshot = { ...record.profileSnapshot, executionMode };
      const nodes = await nodeTransport.listCurrentNodes();
      let connected = true;
      let holdDrain = false;
      const draining = createDeferred();
      const releaseDrain = createDeferred();
      nodeTransport.listCurrentNodes = async () => (connected ? nodes : []);
      nodeTransport.invoke = async (request) => {
        if (request.command === STOP_ENVIRONMENT) {
          return nullReply;
        }
        const input = request.params as NodeWorkerWorkspaceExecInput;
        if (input.argv[0] === DRAIN_WORKSPACE) {
          if (holdDrain) {
            draining.resolve();
            await releaseDrain.promise;
          }
          return drainReply();
        }
        request.onDispatchReady?.("workspace-invoke");
        connected = false;
        return { ok: false, error: { code: "TIMEOUT" } };
      };
      transfer.prepareRepository = vi.fn(async () => {});
      const manager = createManager();
      manager.bindWorkspaceBindingResolver(async () => ({
        source: {
          kind: "repository",
          baseCommit: "a".repeat(40),
          baseManifestRef: `sha256:${"b".repeat(64)}`,
        },
        manifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/node/workspace",
      }));
      const request = { ...startRequest(), executionMode };
      const first = await manager.start(request);
      await expect(
        first.runWorkspaceCommand({ argv: ["write-command"], transportRetry: "never" }),
      ).rejects.toThrow("not connected");
      expect(manager.status(record.environmentId)).toBe("stopped");
      await expect(
        first.runWorkspaceCommand({ argv: ["write-command"], transportRetry: "never" }),
      ).rejects.toThrow("authority closed");

      connected = true;
      holdDrain = true;
      const replacing = manager.start(request);
      await draining.promise;
      try {
        await expectPending(replacing);
      } finally {
        releaseDrain.resolve();
      }
      await replacing;
      expect(manager.status(record.environmentId)).toBe("connected");
      await manager.stop(record.environmentId);
    },
  );

  it.each(["replacement", "active"] as const)(
    "settles the %s launch before closing cancellation authority or exposing a late handle",
    async (mode) => {
      const releaseLaunch = createDeferred();
      let cancellationWasAuthorized = false;
      const onDispatchReady = vi.fn();
      const launchNodeWorker = vi.fn<NodeWorkerLaunch>(async (request) => {
        request.onDispatchReady?.();
        return new Promise<TerminalReceipt>((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              cancellationWasAuthorized = request.isCancellationAuthorized();
              const release = mode === "replacement" ? releaseLaunch.promise : Promise.resolve();
              void release.then(() => resolve(cancelledReceipt(request)));
            },
            { once: true },
          );
        });
      });
      const manager = createManager({ launchNodeWorker });
      const handle = await manager.start(startRequest());
      const launched = launchTurn(handle, {
        timeoutMs: 5_000,
        onDispatchReady: mode === "active" ? onDispatchReady : undefined,
      });
      await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());
      if (mode === "replacement") {
        record.ownerEpoch = 3;
        const replacement = manager.start({ ...startRequest(), ownerEpoch: 3 });
        const stopping = manager.stop("environment-1", 3);
        await expect(replacement).rejects.toThrow("stopped before connecting");
        await expectPending(stopping);
        releaseLaunch.resolve();
        await stopping;
      } else {
        expect(onDispatchReady).toHaveBeenCalledOnce();
        await handle.stop();
        expect(cancellationWasAuthorized).toBe(true);
      }
      await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
      expect(manager.status("environment-1")).toBe("stopped");
    },
  );
});

describe("attached app process lifetime", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("stops a retained foreground process before joining its workspace queue", async ({
    signal,
  }) => {
    enableTransferCleanup();
    const root = tempDirs.make("retained-workspace-shutdown-");
    const receipts = await openFixtureReceiptChannel();
    const workspace = new NodeWorkerWorkspaceRuntime({
      root,
      env: { PATH: path.dirname(process.execPath), HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    const identity = {
      gatewayNamespace: nodeWorkerGatewayNamespace("gateway-device-1"),
      environmentId: record.environmentId,
      sessionId: "session-1",
      generation: record.ownerEpoch,
    };
    const drainReached = createDeferred();
    nodeTransport = workspaceTransport(workspace, (request) => {
      if (
        request.command !== STOP_ENVIRONMENT &&
        parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params)).argv[0] ===
          DRAIN_WORKSPACE
      ) {
        drainReached.resolve();
      }
    });
    const manager = createManager();
    // This command belongs to a previous Gateway connection, so the new tunnel
    // cannot cancel it through a locally retained invocation AbortSignal.
    const foreground = workspace.exec({
      ...identity,
      nativeProcessOwner: true,
      argv: [
        path.basename(process.execPath),
        "--input-type=module",
        "-e",
        `${fixtureReceiptClientSource(receipts.endpoint)}\nsendReceipt(${JSON.stringify(root)}, "ready"); await awaitRelease(${JSON.stringify(root)}, "finish");`,
      ],
    });
    let stopping: Promise<void> | undefined;
    try {
      await withinTest(receipts.waitFor(root, "ready"), signal);
      const first = Promise.race([
        foreground.then(() => "foreground"),
        drainReached.promise.then(() => "drain"),
      ]);
      stopping = manager.stopAll();
      expect(await withinTest(first, signal)).toBe("foreground");
      await withinTest(stopping, signal);
      expect(await foreground).toMatchObject({ killed: true });
    } finally {
      await workspace.processes.close();
      await foreground.catch(() => undefined);
      await stopping?.catch(() => undefined);
      await receipts.close();
    }
  });

  it("preserves attached app processes through Gateway shutdown and same-epoch reconnect", async () => {
    enableTransferCleanup();
    const root = tempDirs.make("attached-workspace-reconnect-");
    const workspace = new NodeWorkerWorkspaceRuntime({
      root,
      env: { PATH: path.dirname(process.execPath), HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    record.sharedHost = false;
    record.attachedSessionIds = [];
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "worker-turn" };
    const binding = {
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId: "conversation-1",
      sessionKey: "agent:main:conversation-1",
    };
    nodeTransport = workspaceTransport(workspace, (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      request.onDispatchReady?.("attached-command");
    });
    const createAttachedManager = () => createManager({ validateWorkerTurn: () => false });
    const managers = [createAttachedManager()];
    const app = [
      path.basename(process.execPath),
      "-e",
      'const s = require("node:http").createServer((_, r) => r.end("same app")); s.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + s.address().port));',
    ];
    const command = (
      manager: ReturnType<typeof createAttachedManager>,
      action: "start" | "status",
      processId: string,
    ) =>
      manager.runSessionCommand(binding, {
        argv: action === "start" ? app : ["openclaw-internal-workspace-process"],
        process: { action, processId },
        transportRetry: "never",
      });
    try {
      const first = managers[0]!;
      await command(first, "start", "first-app");
      let firstUrl = "";
      await vi.waitFor(async () => {
        firstUrl = (await command(first, "status", "first-app")).stdout.trim();
        expect(firstUrl).toMatch(/^http:\/\/127.0.0.1:\d+$/);
      });
      await first.stopAll();
      expect(await (await fetch(firstUrl)).text()).toBe("same app");
      const resumed = createAttachedManager();
      managers.push(resumed);
      expect((await command(resumed, "status", "first-app")).process?.state).toBe("running");
      await command(resumed, "start", "second-app");
      await vi.waitFor(async () =>
        expect((await command(resumed, "status", "second-app")).stdout.trim()).toMatch(
          /^http:\/\/127.0.0.1:\d+$/,
        ),
      );
      expect(record.ownerEpoch).toBe(binding.ownerEpoch);
      expect(record.profileSnapshot.executionMode).toBe("worker-turn");
      await resumed.stopAll();
      expect(await (await fetch(firstUrl)).text()).toBe("same app");
      await workspace.processes.stopEnvironment({
        ...binding,
        gatewayNamespace: nodeWorkerGatewayNamespace("gateway-device-1"),
      });
      await expect(fetch(firstUrl)).rejects.toThrow();
    } finally {
      await Promise.allSettled(managers.map((manager) => manager.stopAll()));
      await workspace.processes.close();
    }
  });
});
