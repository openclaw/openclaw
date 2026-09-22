import { isDeepStrictEqual } from "node:util";
import {
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
} from "../../infra/node-commands.js";
import type { WorkerDesktopApp, WorkerDesktopEndpoint } from "../../plugins/types.js";
import type { DesktopObserveRequester } from "../desktop/observe-requester.js";
import {
  DesktopSessionStaleOwnerError,
  type DesktopSessionRegistry,
} from "../desktop/session-registry.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import {
  isWorkerNodeCarrierBindingCurrent,
  snapshotWorkerNodeCarrierBinding,
  type WorkerNodeCarrierBinding,
  type WorkerNodeCarrierRuntime,
} from "./node-carrier-binding.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { WorkerDesktopObserveResult } from "./service-contract.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const APP_LAUNCH_TIMEOUT_MS = 30_000;

type NodeDesktopBinding = WorkerNodeCarrierBinding & {
  desktop: WorkerDesktopEndpoint;
};

type ActiveNodeDesktopStream = {
  binding: NodeDesktopBinding;
  stream: ReturnType<DesktopSessionRegistry["createStream"]>;
};

type ActiveNodeDesktopLaunch = {
  binding: NodeDesktopBinding;
  app: WorkerDesktopApp;
  controller: AbortController;
  operation: Promise<void>;
};

type WorkerNodeDesktopCarrierOptions = {
  store: Pick<WorkerEnvironmentStore, "get">;
  desktopRegistry: DesktopSessionRegistry;
};

function snapshotNodeDesktopBinding(record: WorkerEnvironmentRecord): NodeDesktopBinding {
  const message = "Worker environment node desktop owner is not active";
  const binding = snapshotWorkerNodeCarrierBinding(record, message);
  if (!record.desktop) {
    throw new Error(message);
  }
  return { ...binding, desktop: structuredClone(record.desktop) };
}

function isBindingCurrent(
  store: Pick<WorkerEnvironmentStore, "get">,
  binding: NodeDesktopBinding,
): boolean {
  const current = store.get(binding.environmentId);
  return Boolean(
    current &&
    isWorkerNodeCarrierBindingCurrent(current, binding) &&
    current.desktop !== null &&
    isDeepStrictEqual(current.desktop, binding.desktop),
  );
}

function invocationError(
  result: Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>,
): Error {
  const message = result.error?.message?.trim();
  return new Error(message || "worker node desktop stream closed before attachment");
}

function requireLaunchReady(
  result: Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>,
): void {
  if (!result.ok) {
    throw invocationError(result);
  }
  let payload: unknown;
  try {
    payload = result.payloadJSON ? JSON.parse(result.payloadJSON) : undefined;
  } catch {
    throw new Error("Worker environment node desktop launcher returned malformed JSON");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !("status" in payload) ||
    payload.status !== "ready"
  ) {
    throw new Error("Worker environment node desktop launcher returned an invalid result");
  }
}

function launchKey(binding: NodeDesktopBinding, app: WorkerDesktopApp): string {
  return `${binding.environmentId}\0${app.id}`;
}

/** Carries one durable worker environment's desktop over its private node connection. */
export function createWorkerNodeDesktopCarrier(options: WorkerNodeDesktopCarrierOptions) {
  let runtime: WorkerNodeCarrierRuntime | undefined;
  const ownedEnvironmentIds = new Set<string>();
  const activeStreams = new Set<ActiveNodeDesktopStream>();
  const activeLaunches = new Map<string, ActiveNodeDesktopLaunch>();

  const bindingIsCurrent = (
    binding: NodeDesktopBinding,
    capturedRuntime: WorkerNodeCarrierRuntime,
    node: NodeWorkerSupervisorNodeProof,
  ): boolean =>
    // A broker ticket proves the node connection only. The durable environment row remains
    // the authority for whether that connection may still act for this desktop owner.
    runtime === capturedRuntime &&
    isBindingCurrent(options.store, binding) &&
    capturedRuntime.transport.isCurrent(node, false);

  const findCurrentNode = async (
    binding: NodeDesktopBinding,
    capturedRuntime: WorkerNodeCarrierRuntime,
    signal: AbortSignal,
  ): Promise<NodeWorkerSupervisorNodeProof> => {
    signal.throwIfAborted();
    const node = await raceNodeWorkerOperation(
      capturedRuntime.transport.getCurrentNode(binding.nodeDeviceId),
      signal,
      {
        aborted: "Worker environment node desktop operation aborted",
        failed: "Node desktop operation failed",
      },
    );
    signal.throwIfAborted();
    if (!node || !bindingIsCurrent(binding, capturedRuntime, node)) {
      throw new Error("Worker environment node desktop connection is not current");
    }
    return node;
  };

  const stopLaunch = async (active: ActiveNodeDesktopLaunch): Promise<void> => {
    active.controller.abort(new Error("Worker environment node desktop owner stopped"));
    await active.operation.catch(() => undefined);
  };

  const stopOwnedOperations = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    const streams = [...activeStreams].filter(
      (active) =>
        active.binding.environmentId === environmentId &&
        (ownerEpoch === undefined || active.binding.ownerEpoch === ownerEpoch),
    );
    const launches = [...activeLaunches.values()].filter(
      (active) =>
        active.binding.environmentId === environmentId &&
        (ownerEpoch === undefined || active.binding.ownerEpoch === ownerEpoch),
    );
    await Promise.all([
      ...streams.map((active) => active.stream.stop()),
      ...launches.map(stopLaunch),
    ]);
  };

  const claimOwner = async (binding: NodeDesktopBinding): Promise<void> => {
    let advanced: boolean;
    try {
      advanced = options.desktopRegistry.claimOwnerEpoch(binding.environmentId, binding.ownerEpoch);
    } catch (error) {
      if (error instanceof DesktopSessionStaleOwnerError) {
        throw new Error("Worker environment node desktop owner epoch is stale", { cause: error });
      }
      throw error;
    }
    if (!advanced) {
      return;
    }
    const staleStreams = [...activeStreams].filter(
      (active) =>
        active.binding.environmentId === binding.environmentId &&
        active.binding.ownerEpoch < binding.ownerEpoch,
    );
    const staleLaunches = [...activeLaunches.values()].filter(
      (active) =>
        active.binding.environmentId === binding.environmentId &&
        active.binding.ownerEpoch < binding.ownerEpoch,
    );
    await options.desktopRegistry.stopSuperseded(binding.environmentId, binding.ownerEpoch);
    await Promise.all([
      ...staleStreams.map((active) => active.stream.stop()),
      ...staleLaunches.map(stopLaunch),
    ]);
  };

  const observe = async (request: {
    record: WorkerEnvironmentRecord;
    control: boolean;
    requester?: DesktopObserveRequester;
  }): Promise<WorkerDesktopObserveResult> => {
    const binding = snapshotNodeDesktopBinding(request.record);
    const active: ActiveNodeDesktopStream = {
      binding,
      stream: options.desktopRegistry.createStream({
        sourceKey: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        onStopped: () => {
          activeStreams.delete(active);
        },
      }),
    };
    const signal = request.requester?.signal
      ? AbortSignal.any([active.stream.signal, request.requester.signal])
      : active.stream.signal;
    const assertRequesterCurrent = () => {
      signal.throwIfAborted();
      if (request.requester?.isCurrent() === false) {
        throw new Error("Desktop observer connection is no longer current");
      }
    };
    assertRequesterCurrent();
    // Publish ownership before discovery can yield so drain/destroy can abort this attempt.
    activeStreams.add(active);
    ownedEnvironmentIds.add(binding.environmentId);
    try {
      await claimOwner(binding);
      assertRequesterCurrent();
      await options.desktopRegistry.activate({
        sourceKey: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        teardown: async () => {
          await stopOwnedOperations(binding.environmentId, binding.ownerEpoch);
        },
      });
      assertRequesterCurrent();
      const capturedRuntime = runtime;
      if (!capturedRuntime) {
        throw new Error("Worker environment node desktop runtime is unavailable");
      }
      const node = await findCurrentNode(binding, capturedRuntime, signal);
      assertRequesterCurrent();
      if (!active.stream.reserve()) {
        throw new Error("Worker environment desktop observer limit reached");
      }
      const ticket = capturedRuntime.streamBroker.mint({
        nodeId: node.nodeId,
        connId: node.connId,
        pairingGeneration: node.pairingGeneration,
      });
      const attached = await active.stream.connect(ticket, () =>
        capturedRuntime.transport.invoke({
          node,
          command: NODE_WORKER_DESKTOP_STREAM_COMMAND,
          params: {
            ticket: ticket.ticket,
            attachPath: ticket.attachPath,
            port: binding.desktop.port,
            ...(binding.desktop.username ? { username: binding.desktop.username } : {}),
            ...(binding.desktop.passwordFilePath
              ? { passwordFilePath: binding.desktop.passwordFilePath }
              : {}),
          },
          timeoutMs: 0,
          signal,
          isDispatchAuthorized: () =>
            !signal.aborted &&
            request.requester?.isCurrent() !== false &&
            bindingIsCurrent(binding, capturedRuntime, node),
        }),
      );
      assertRequesterCurrent();
      if (!bindingIsCurrent(binding, capturedRuntime, node)) {
        throw new Error("Worker environment node desktop owner changed before attachment");
      }
      const expectedAuth = binding.desktop.username ? "ard-account" : "vnc-password";
      if (attached.auth !== expectedAuth || !attached.vncPassword) {
        throw new Error("Worker environment node desktop did not provide managed authentication");
      }
      const { DESKTOP_OBSERVE_PATH, mintDesktopObserverToken } =
        await import("../desktop/observe-bridge.js");
      assertRequesterCurrent();
      if (!bindingIsCurrent(binding, capturedRuntime, node)) {
        throw new Error("Worker environment node desktop owner changed before publication");
      }
      const attachment = active.stream.publish();
      if (!attachment) {
        throw new Error("Worker environment node desktop owner changed before publication");
      }
      const issuedAtMs = Date.now();
      const minted = mintDesktopObserverToken({
        sourceKey: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        control: request.control,
        requester: request.requester,
        attachment,
        onAbandon: active.stream.stop,
        preauth: binding.desktop.username
          ? {
              auth: "ard-account",
              credentials: { username: binding.desktop.username, password: attached.vncPassword },
            }
          : { auth: "vnc-password", credentials: { password: attached.vncPassword } },
        nowMs: issuedAtMs,
      });
      active.stream.expireAt(minted.expiresAtMs);
      return {
        transport: "rfb",
        wsPath: `${DESKTOP_OBSERVE_PATH}?token=${minted.token}`,
        expiresAtMs: minted.expiresAtMs,
        control: request.control,
      };
    } catch (error) {
      await active.stream.stop();
      throw error;
    }
  };

  const launchApp = (request: {
    record: WorkerEnvironmentRecord;
    app: WorkerDesktopApp;
  }): Promise<void> => {
    const binding = snapshotNodeDesktopBinding(request.record);
    const advertisedApp = binding.desktop.apps?.find((app) => app.id === request.app.id);
    if (!advertisedApp || !isDeepStrictEqual(advertisedApp, request.app)) {
      return Promise.reject(
        new Error("Worker environment node desktop app descriptor is not current"),
      );
    }
    const app = structuredClone(advertisedApp);
    const key = launchKey(binding, app);
    const previous = activeLaunches.get(key);
    if (
      previous?.binding.ownerEpoch === binding.ownerEpoch &&
      isDeepStrictEqual(previous.app, app)
    ) {
      return previous.operation;
    }
    const controller = new AbortController();
    const operation = Promise.resolve().then(async () => {
      await claimOwner(binding);
      if (previous) {
        previous.controller.abort(
          new Error("Worker environment node desktop launch owner replaced"),
        );
        await previous.operation.catch(() => undefined);
      }
      controller.signal.throwIfAborted();
      const capturedRuntime = runtime;
      if (!capturedRuntime) {
        throw new Error("Worker environment node desktop runtime is unavailable");
      }
      const node = await findCurrentNode(binding, capturedRuntime, controller.signal);
      if (activeLaunches.get(key) !== entry) {
        throw new Error("Worker environment node desktop launch owner was replaced");
      }
      const result = await capturedRuntime.transport.invoke({
        node,
        command: NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
        params: app,
        timeoutMs: APP_LAUNCH_TIMEOUT_MS,
        signal: controller.signal,
        isDispatchAuthorized: () =>
          !controller.signal.aborted && bindingIsCurrent(binding, capturedRuntime, node),
      });
      requireLaunchReady(result);
      if (!bindingIsCurrent(binding, capturedRuntime, node)) {
        throw new Error("Worker environment node desktop launch owner changed");
      }
    });
    const entry: ActiveNodeDesktopLaunch = {
      binding,
      app,
      controller,
      operation,
    };
    // Stateful launch is visible to teardown before node discovery or dispatch begins.
    activeLaunches.set(key, entry);
    ownedEnvironmentIds.add(binding.environmentId);
    void operation
      .finally(() => {
        if (activeLaunches.get(key) === entry) {
          activeLaunches.delete(key);
        }
      })
      .catch(() => undefined);
    return operation;
  };

  const stop = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await Promise.all([
      options.desktopRegistry.stop(environmentId, ownerEpoch),
      stopOwnedOperations(environmentId, ownerEpoch),
    ]);
  };

  const stopAll = async (): Promise<void> => {
    await Promise.all([...ownedEnvironmentIds].map((environmentId) => stop(environmentId)));
  };

  return {
    bindRuntime(next: WorkerNodeCarrierRuntime): void {
      runtime = next;
    },
    launchApp,
    observe,
    stop,
    stopAll,
  };
}

export type WorkerNodeDesktopCarrier = ReturnType<typeof createWorkerNodeDesktopCarrier>;
