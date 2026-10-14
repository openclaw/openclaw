import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_RPC_SET_VERSION } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../../infra/node-commands.js";
import { resolveNodeWorkerLaunchToolNames } from "../../infra/node-runner-inventory.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import {
  nodeWorkerPlanHash,
  parseNodeWorkerEnvironmentStopInput,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorReceipt,
} from "../../worker/node-supervisor-protocol.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createDeviceWorkerRuntime } from "./device-provider.js";
import {
  createNodeWorkerLaunchAdapter,
  measureNodeWorkerLaunchBytes,
} from "./node-launch-adapter.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  BUILD,
  createManager,
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceTransfer,
  workspaceCommandPayload,
} from "./node-worker-tunnel.test-support.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";

type NodeWorkerLaunch = ReturnType<typeof createDeviceWorkerRuntime>["launchNodeWorker"];
type TerminalReceipt = Extract<
  NodeWorkerSupervisorReceipt,
  { state: "completed" | "failed" | "interrupted" | "cancelled" }
>;

function plan() {
  return parseWorkerLaunchPlan({
    version: 4,
    admission: {
      environmentId: "environment-1",
      credential: "worker-credential-fixture",
      sessionId: "session-1",
      ownerEpoch: 2,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: BUILD,
    },
    assignment: {
      agentId: "main",
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      agentRuntimeIdentityToken: "runtime-token",
      runId: "run-1",
      turnId: "turn-1",
      prompt: "inspect",
      suppressPromptTranscript: true,
      workspaceDir: "/node/workspace",
      modelRef: { provider: "openai", model: "gpt-5.6-luna" },
      inferenceOptions: {},
      initialMessages: [],
      transcript: { baseLeafId: null, nextSeq: 1 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: { allowedToolNames: [] },
    },
  });
}

function turnClaim() {
  return {
    sessionId: "session-1",
    claimId: "claim-1",
    runId: "run-1",
    placementGeneration: 4,
    owner: { kind: "worker" as const, environmentId: "environment-1", ownerEpoch: 2 },
  };
}

describe("node worker tunnel lifetime", () => {
  it("reads the current destination's launch vocabulary with a legacy fallback while offline", async () => {
    const nodeTransport = transport();
    const nodes = await nodeTransport.listCurrentNodes();
    const node = nodes[0]!;
    nodeTransport.listCurrentNodes = async () => nodes;
    let currentTransport: NodeWorkerSupervisorTransport | undefined = nodeTransport;
    const manager = createManager(environment(), { getTransport: () => currentTransport });
    const handle = await manager.start(startRequest());
    const legacy = resolveNodeWorkerLaunchToolNames(node.workerHost);
    await expect(handle.readLaunchToolNames()).resolves.toEqual(legacy);

    node.workerHost.launchToolNames = [];
    await expect(handle.readLaunchToolNames()).resolves.toEqual([]);
    node.workerHost.launchToolNames = ["read", "presence"];
    await expect(handle.readLaunchToolNames()).resolves.toEqual(["read", "presence"]);

    nodeTransport.listCurrentNodes = async () => [];
    await expect(handle.readLaunchToolNames()).resolves.toEqual(legacy);
    currentTransport = undefined;
    await expect(handle.readLaunchToolNames()).resolves.toEqual(legacy);
  });

  it("revalidates the exact claim when a same-run replacement launches", async () => {
    const record = environment();
    let currentClaim = turnClaim();
    const authorizations: boolean[] = [];
    const launchSizes: number[] = [];
    const manager = createManager(record, {
      launchNodeWorker: vi.fn<NodeWorkerLaunch>(async (request) => {
        authorizations.push(request.isDispatchAuthorized());
        launchSizes.push(measureNodeWorkerLaunchBytes(request.deviceId, request.input));
        return {
          launchId: request.input.launchId,
          planHash: "b".repeat(64),
          environmentId: request.input.descriptor.admission.environmentId,
          sessionId: request.input.descriptor.admission.sessionId,
          ownerEpoch: request.input.descriptor.admission.ownerEpoch,
          placementGeneration: request.input.placementGeneration,
          runId: request.input.descriptor.assignment.runId,
          state: "cancelled",
          errorText: "test launch finished",
        };
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
    const record = environment();
    let currentClaim = turnClaim();
    let firstLaunch = true;
    const stopEntered = createDeferred();
    const stopAck = createDeferred();
    const invoked: string[] = [];
    const nodeTransport = transport();
    const nodes = await nodeTransport.listCurrentNodes();
    nodes[0]!.workerHost.capturedExecPolicy = true;
    nodes[0]!.workerHost.promptContext = 1;
    nodeTransport.listCurrentNodes = async () => nodes;
    nodeTransport.invoke = withWorkspaceDrain(async (request) => {
      invoked.push(request.command);
      if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        stopEntered.resolve();
        await stopAck.promise;
        return { ok: true, payloadJSON: "null" };
      }
      if (request.command === NODE_WORKER_SUPERVISOR_CANCEL_COMMAND) {
        return { ok: false, error: { code: "INVALID_REQUEST" } };
      }
      if (request.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND) {
        const signal = request.signal;
        if (!signal) {
          throw new Error("expected node status signal");
        }
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("node status aborted"),
              ),
            { once: true },
          );
        });
      }
      const input = request.params as NodeWorkerLaunchInput;
      const identity = {
        launchId: input.launchId,
        planHash: nodeWorkerPlanHash(input),
        environmentId: input.descriptor.admission.environmentId,
        sessionId: input.descriptor.admission.sessionId,
        ownerEpoch: input.descriptor.admission.ownerEpoch,
        placementGeneration: input.placementGeneration,
        runId: input.descriptor.assignment.runId,
      };
      if (request.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND) {
        request.onDispatchReady?.("launch-invoke");
        if (firstLaunch) {
          firstLaunch = false;
          return { ok: true, payloadJSON: JSON.stringify({ ...identity, state: "running" }) };
        }
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ...identity,
            state: "completed",
            resultJson: '{"status":"completed"}',
          }),
        };
      }
      throw new Error(`unexpected node command: ${request.command}`);
    });
    const launchAdapter = createNodeWorkerLaunchAdapter({
      getTransport: () => nodeTransport,
      sleep: async () => {},
    });
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      launchNodeWorker: launchAdapter.launch,
      validateWorkerTurn: (claim) => sameWorkerSessionTurnClaim(claim, currentClaim),
    });
    const first = await manager.start(startRequest());
    const staleClaim = currentClaim;
    currentClaim = { ...staleClaim, claimId: "claim-2" };

    await expect(first.launchTurn({ plan: plan(), turnClaim: staleClaim })).rejects.toThrow(
      "authority closed",
    );
    expect(invoked).toEqual([]);

    const controller = new AbortController();
    const unconfirmed = first.launchTurn({
      plan: plan(),
      turnClaim: currentClaim,
      signal: controller.signal,
    });
    const unconfirmedRejection = expect(unconfirmed).rejects.toThrow(
      "node worker launch failed and cancellation could not be confirmed",
    );
    await vi.waitFor(() => expect(invoked).toContain(NODE_WORKER_SUPERVISOR_STATUS_COMMAND));
    expect(invoked).toEqual([
      NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
    ]);
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
    let replacementReady = false;
    void replacing.then(() => {
      replacementReady = true;
    });
    await Promise.resolve();
    expect(replacementReady).toBe(false);
    stopAck.resolve();
    const replacement = await replacing;

    const replacementPlan = plan();
    replacementPlan.admission.ownerEpoch = 3;
    await expect(
      replacement.launchTurn({ plan: replacementPlan, turnClaim: currentClaim }),
    ).resolves.toMatchObject({ code: 0 });
    expect(invoked).toEqual([
      NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
      NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
      NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
      NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
      NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
    ]);
    await manager.stop(record.environmentId, 3, "provider-destroyed");
  });

  it("reuses only the exact same epoch binding", async () => {
    const record = environment();
    const manager = createManager(record);

    const first = await manager.start(startRequest());
    await expect(manager.start(startRequest())).resolves.toBe(first);
    await expect(manager.start({ ...startRequest(), sessionId: "session-other" })).rejects.toThrow(
      "binding changed",
    );
  });

  it("closes remote-exec workspaces without requiring an embedded worker lifetime command", async () => {
    const record = environment();
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "remote-exec" };
    const nodeTransport = transport();
    const nodes = await nodeTransport.listCurrentNodes();
    for (const node of nodes) {
      delete node.workerHost.environmentSession;
    }
    nodeTransport.listCurrentNodes = async () => nodes;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const transfer = workspaceTransfer();
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start({ ...startRequest(), executionMode: "remote-exec" });
    await expect(handle.launchTurn({ plan: plan(), turnClaim: turnClaim() })).rejects.toThrow(
      "remote-exec",
    );
    // Later durable changes cannot widen the retiring handle's process ownership.
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "worker-turn" };
    await handle.stop();
    expect(invoke).not.toHaveBeenCalled();
    expect(transfer.close).toHaveBeenCalledExactlyOnceWith(record.environmentId);
  });

  it("stops a completed turn's environment before exposing its replacement", async () => {
    const record = environment();
    const stopped = createDeferred();
    const nodeTransport = transport();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      await stopped.promise;
      return { ok: true, payloadJSON: "null" };
    });
    nodeTransport.invoke = withWorkspaceDrain(invoke);
    const manager = createManager(record, {
      getTransport: () => nodeTransport,
      launchNodeWorker: async (request) => ({
        launchId: request.input.launchId,
        planHash: "b".repeat(64),
        environmentId: record.environmentId,
        sessionId: "session-1",
        ownerEpoch: 2,
        placementGeneration: 4,
        runId: "run-1",
        state: "completed",
        resultJson: '{"status":"completed"}',
      }),
    });
    const first = await manager.start(startRequest());
    await expect(first.launchTurn({ plan: plan(), turnClaim: turnClaim() })).resolves.toMatchObject(
      { code: 0 },
    );
    record.ownerEpoch = 3;
    const replacing = manager.start({ ...startRequest(), ownerEpoch: 3 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(manager.status(record.environmentId)).toBe("connecting");
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
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
      const record = environment();
      record.bootstrapReceipt = null;
      const nodeTransport = transport();
      const invoke = vi
        .fn<NodeWorkerSupervisorTransport["invoke"]>()
        .mockResolvedValueOnce({ ok: false, error: { code: "DISCONNECTED" } })
        .mockResolvedValue({ ok: true, payloadJSON: "null" });
      nodeTransport.invoke = withWorkspaceDrain(invoke);
      const transfer = { ...workspaceTransfer(), closeAll: vi.fn(async () => {}) };
      const manager = createManager(record, {
        getTransport: () => nodeTransport,
        workspaceTransfer: transfer,
      });
      const stop = () =>
        operation === "stop" ? manager.stop(record.environmentId, 2) : manager.stopAll();

      await expect(stop()).rejects.toThrow("DISCONNECTED");
      expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized()).toBe(false);
      await stop();
      expect(invoke.mock.calls.map(([request]) => request.params)).toEqual([
        expect.objectContaining({
          environmentId: record.environmentId,
          sessionId: "session-1",
          ownerEpoch: 2,
        }),
        expect.objectContaining({
          environmentId: record.environmentId,
          sessionId: "session-1",
          ownerEpoch: 2,
        }),
      ]);
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "fences an unconfirmed workspace command until its %s owner drains after reconnect",
    async (executionMode) => {
      const record = environment();
      record.profileSnapshot = { ...record.profileSnapshot, executionMode };
      const nodeTransport = transport();
      const nodes = await nodeTransport.listCurrentNodes();
      let connected = true;
      let holdDrain = false;
      const draining = createDeferred();
      const releaseDrain = createDeferred();
      nodeTransport.listCurrentNodes = async () => (connected ? nodes : []);
      nodeTransport.invoke = async (request) => {
        if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
          return { ok: true, payloadJSON: "null" };
        }
        const input = request.params as NodeWorkerWorkspaceExecInput;
        if (input.argv[0] === NODE_WORKSPACE_DRAIN_COMMAND) {
          if (holdDrain) {
            draining.resolve();
            await releaseDrain.promise;
          }
          return {
            ok: true,
            payloadJSON: workspaceCommandPayload("/node/workspace", { stdout: "drained\n" }),
          };
        }
        request.onDispatchReady?.("workspace-invoke");
        connected = false;
        return { ok: false, error: { code: "TIMEOUT" } };
      };
      const transfer = workspaceTransfer();
      transfer.prepareRepository = vi.fn(async () => {});
      const manager = createManager(record, {
        getTransport: () => nodeTransport,
        workspaceTransfer: transfer,
      });
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
      let ready = false;
      const replacing = manager.start(request).then((handle) => {
        ready = true;
        return handle;
      });
      await draining.promise;
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(ready).toBe(false);
      } finally {
        releaseDrain.resolve();
      }
      await replacing;
      expect(manager.status(record.environmentId)).toBe("connected");
      await manager.stop(record.environmentId);
    },
  );

  it("cancels a replacement start before it can install a late handle", async () => {
    const record = environment();
    const releaseLaunch = createDeferred();
    const launch: NodeWorkerLaunch = async (request): Promise<TerminalReceipt> =>
      await new Promise<TerminalReceipt>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            void releaseLaunch.promise.then(() => {
              resolve({
                launchId: request.input.launchId,
                planHash: "b".repeat(64),
                environmentId: request.input.descriptor.admission.environmentId,
                sessionId: request.input.descriptor.admission.sessionId,
                ownerEpoch: request.input.descriptor.admission.ownerEpoch,
                placementGeneration: request.input.placementGeneration,
                runId: request.input.descriptor.assignment.runId,
                state: "cancelled",
                errorText: "node worker cancelled",
              });
            });
          },
          { once: true },
        );
      });
    const launchNodeWorker = vi.fn(launch);
    const manager = createManager(record, {
      launchNodeWorker,
    });
    const first = await manager.start(startRequest());
    const launched = first.launchTurn({
      plan: plan(),
      turnClaim: turnClaim(),
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());
    record.ownerEpoch = 3;
    const replacement = manager.start({ ...startRequest(), ownerEpoch: 3 });

    const stopping = manager.stop("environment-1", 3);
    const stopSettled = vi.fn();
    void stopping.then(stopSettled, stopSettled);
    await expect(replacement).rejects.toThrow("stopped before connecting");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(stopSettled).not.toHaveBeenCalled();
    releaseLaunch.resolve();
    await stopping;

    await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
    expect(manager.status("environment-1")).toBe("stopped");
  });

  it("keeps cancellation authorized until an active launch settles", async () => {
    const record = environment();
    let cancellationWasAuthorized = false;
    const onDispatchReady = vi.fn();
    const launch: NodeWorkerLaunch = async (request): Promise<TerminalReceipt> => {
      request.onDispatchReady?.();
      return await new Promise<TerminalReceipt>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            cancellationWasAuthorized = request.isCancellationAuthorized();
            resolve({
              launchId: request.input.launchId,
              planHash: "b".repeat(64),
              environmentId: request.input.descriptor.admission.environmentId,
              sessionId: request.input.descriptor.admission.sessionId,
              ownerEpoch: request.input.descriptor.admission.ownerEpoch,
              placementGeneration: request.input.placementGeneration,
              runId: request.input.descriptor.assignment.runId,
              state: "cancelled",
              errorText: "node worker cancelled",
            });
          },
          { once: true },
        );
      });
    };
    const launchNodeWorker = vi.fn(launch);
    const manager = createManager(record, {
      launchNodeWorker,
    });
    const handle = await manager.start(startRequest());
    const launched = handle.launchTurn({
      plan: plan(),
      turnClaim: turnClaim(),
      timeoutMs: 5_000,
      onDispatchReady,
    });
    await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());
    expect(onDispatchReady).toHaveBeenCalledOnce();

    await handle.stop();

    await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
    expect(cancellationWasAuthorized).toBe(true);
    expect(manager.status("environment-1")).toBe("stopped");
  });
});

describe("attached app process lifetime", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("preserves attached app processes through Gateway shutdown and same-epoch reconnect", async () => {
    const root = tempDirs.make("attached-workspace-reconnect-");
    const workspace = new NodeWorkerWorkspaceRuntime({
      root,
      env: { PATH: path.dirname(process.execPath), HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    const record = {
      ...environment(),
      providerId: "crabbox",
      sharedHost: false,
      attachedSessionIds: [],
      profileSnapshot: { executionMode: "worker-turn" as const, settings: {} },
    };
    const binding = {
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId: "conversation-1",
      sessionKey: "agent:main:conversation-1",
    };
    const gatewayDeviceId = "gateway-device-1";
    const nodeTransport = transport();
    nodeTransport.invoke = async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      request.onDispatchReady?.("attached-command");
      if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        await workspace.processes.stopEnvironment(
          parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params)),
        );
        return { ok: true, payloadJSON: "null" };
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify(
          await workspace.exec(
            parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params)),
            request.signal,
          ),
        ),
      };
    };
    const createAttachedManager = () =>
      createNodeWorkerTunnelManager({
        gatewayDeviceId,
        getEnvironment: () => record,
        listEnvironments: () => [record],
        getTransport: () => nodeTransport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: () => false,
        workspaceTransfer: { ...workspaceTransfer(), closeAll: vi.fn(async () => {}) },
      });
    const managers = [createAttachedManager()];
    const start = (manager: ReturnType<typeof createAttachedManager>, processId: string) =>
      manager.runSessionCommand(binding, {
        argv: [
          path.basename(process.execPath),
          "-e",
          'const s = require("node:http").createServer((_, r) => r.end("same app")); s.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + s.address().port));',
        ],
        process: { action: "start", processId },
        transportRetry: "never",
      });
    const read = (manager: ReturnType<typeof createAttachedManager>, processId: string) =>
      manager.runSessionCommand(binding, {
        argv: ["openclaw-internal-workspace-process"],
        process: { action: "status", processId },
        transportRetry: "never",
      });
    try {
      const first = managers[0]!;
      await start(first, "first-app");
      let firstUrl = "";
      await vi.waitFor(async () => {
        firstUrl = (await read(first, "first-app")).stdout.trim();
        expect(firstUrl).toMatch(/^http:\/\/127.0.0.1:\d+$/);
      });
      await first.stopAll();
      expect(await (await fetch(firstUrl)).text()).toBe("same app");
      const resumed = createAttachedManager();
      managers.push(resumed);
      expect((await read(resumed, "first-app")).process?.state).toBe("running");
      await start(resumed, "second-app");
      await vi.waitFor(async () =>
        expect((await read(resumed, "second-app")).stdout.trim()).toMatch(
          /^http:\/\/127.0.0.1:\d+$/,
        ),
      );
      expect(record.ownerEpoch).toBe(binding.ownerEpoch);
      expect(record.profileSnapshot.executionMode).toBe("worker-turn");
      await resumed.stopAll();
      expect(await (await fetch(firstUrl)).text()).toBe("same app");
      await workspace.processes.stopEnvironment({
        ...binding,
        gatewayNamespace: nodeWorkerGatewayNamespace(gatewayDeviceId),
      });
      await expect(fetch(firstUrl)).rejects.toThrow();
    } finally {
      await Promise.allSettled(managers.map((manager) => manager.stopAll()));
      await workspace.processes.close();
    }
  });
});
