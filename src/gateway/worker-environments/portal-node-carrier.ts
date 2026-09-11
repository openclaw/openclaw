import type { Duplex } from "node:stream";
import { NODE_WORKER_PORTAL_STREAM_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_PORTAL_STREAM_VERSION } from "../../infra/node-runner-inventory.js";
import type { NodeDesktopStreamBroker } from "../desktop/node-stream-broker.js";
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
import type { WorkerEnvironmentStore } from "./store.js";

type ActiveNodePortal = {
  binding: WorkerNodeCarrierBinding;
  controller: AbortController;
  streams: Set<ActiveNodePortalStream>;
  closed: boolean;
};

type ActiveNodePortalStream = {
  portal: ActiveNodePortal;
  controller: AbortController;
  ticket?: ReturnType<NodeDesktopStreamBroker["mintPortal"]>;
  invocation?: ReturnType<NodeWorkerSupervisorTransport["invoke"]>;
  stream?: Duplex;
  stopped: boolean;
};

const UNSUPPORTED_NODE_PORTAL_MESSAGE =
  "Portals require a current cloud-worker node with portal stream support; move the session back to the gateway with sessions.move";

/** Opens one ticketed node connection per request while its durable portal owner remains current. */
export function createWorkerNodePortalCarrier(options: {
  store: Pick<WorkerEnvironmentStore, "get">;
}) {
  let runtime: WorkerNodeCarrierRuntime | undefined;
  const activePortals = new Set<ActiveNodePortal>();

  const bindingIsCurrent = (
    binding: WorkerNodeCarrierBinding,
    capturedRuntime: WorkerNodeCarrierRuntime,
    node: NodeWorkerSupervisorNodeProof,
  ): boolean =>
    runtime === capturedRuntime &&
    isWorkerNodeCarrierBindingCurrent(options.store.get(binding.environmentId), binding) &&
    node.workerHost.portalStream === NODE_WORKER_PORTAL_STREAM_VERSION &&
    capturedRuntime.transport.isCurrent(node, false);

  const findCurrentNode = async (
    binding: WorkerNodeCarrierBinding,
    capturedRuntime: WorkerNodeCarrierRuntime,
    signal?: AbortSignal,
  ): Promise<NodeWorkerSupervisorNodeProof> => {
    const discovery = capturedRuntime.transport.listCurrentNodes();
    const nodes = signal
      ? await raceNodeWorkerOperation(discovery, signal, {
          aborted: "Worker environment node portal owner stopped",
        })
      : await discovery;
    signal?.throwIfAborted();
    const node = nodes.find((candidate) => candidate.nodeId === binding.nodeDeviceId);
    if (!node || !bindingIsCurrent(binding, capturedRuntime, node)) {
      throw new Error(UNSUPPORTED_NODE_PORTAL_MESSAGE);
    }
    return node;
  };

  const retireStream = (active: ActiveNodePortalStream): void => {
    if (active.stopped) {
      return;
    }
    active.stopped = true;
    active.ticket?.cancel();
    active.controller.abort(new Error("Worker environment node portal stream stopped"));
    active.stream?.destroy();
    active.portal.streams.delete(active);
  };

  const stopStream = async (active: ActiveNodePortalStream): Promise<void> => {
    retireStream(active);
    await active.invocation?.catch(() => undefined);
  };

  const closePortal = async (portal: ActiveNodePortal): Promise<void> => {
    if (portal.closed) {
      return;
    }
    portal.closed = true;
    portal.controller.abort(new Error("Worker environment node portal owner stopped"));
    activePortals.delete(portal);
    await Promise.all([...portal.streams].map(stopStream));
  };

  const connectPortal = async (portal: ActiveNodePortal, remotePort: number): Promise<Duplex> => {
    const capturedRuntime = runtime;
    if (!capturedRuntime || portal.closed || portal.controller.signal.aborted) {
      throw new Error(UNSUPPORTED_NODE_PORTAL_MESSAGE);
    }
    const active: ActiveNodePortalStream = {
      portal,
      controller: new AbortController(),
      stopped: false,
    };
    // Publish the connection before node discovery yields so owner teardown can fence it.
    portal.streams.add(active);
    try {
      const node = await findCurrentNode(portal.binding, capturedRuntime, active.controller.signal);
      active.ticket = capturedRuntime.streamBroker.mintPortal({
        nodeId: node.nodeId,
        connId: node.connId,
        pairingGeneration: node.pairingGeneration,
      });
      active.invocation = capturedRuntime.transport.invoke({
        node,
        command: NODE_WORKER_PORTAL_STREAM_COMMAND,
        params: {
          ticket: active.ticket.ticket,
          attachPath: active.ticket.attachPath,
          port: remotePort,
        },
        timeoutMs: 0,
        signal: active.controller.signal,
        isDispatchAuthorized: () =>
          !portal.closed && bindingIsCurrent(portal.binding, capturedRuntime, node),
      });
      // The invocation lives for the splice; finishing before attachment is a dial failure.
      const invocationFinished = active.invocation.then((result) => {
        throw new Error(
          result.error?.message?.trim() ||
            "Worker environment node portal closed before attachment",
        );
      });
      void invocationFinished.catch(() => undefined);
      const attached = await Promise.race([active.ticket.attached, invocationFinished]);
      active.stream = attached.stream;
      if (portal.closed || !bindingIsCurrent(portal.binding, capturedRuntime, node)) {
        throw new Error("Worker environment node portal owner changed before attachment");
      }
      active.stream.once("close", () => retireStream(active));
      void active.invocation.finally(() => retireStream(active)).catch(() => undefined);
      return active.stream;
    } catch (error) {
      await stopStream(active);
      throw error;
    }
  };

  return {
    bindRuntime(next: WorkerNodeCarrierRuntime): void {
      if (runtime && runtime !== next) {
        for (const portal of activePortals) {
          for (const stream of portal.streams) {
            retireStream(stream);
          }
        }
      }
      runtime = next;
    },
    async supports(environmentId: string, ownerEpoch: number): Promise<boolean> {
      const capturedRuntime = runtime;
      if (!capturedRuntime) {
        return false;
      }
      try {
        const binding = snapshotWorkerNodeCarrierBinding(
          options.store.get(environmentId),
          UNSUPPORTED_NODE_PORTAL_MESSAGE,
          ownerEpoch,
        );
        await findCurrentNode(binding, capturedRuntime);
        return true;
      } catch {
        return false;
      }
    },
    async open(request: {
      environmentId: string;
      ownerEpoch: number;
      remotePort: number;
    }): Promise<{ connect: () => Promise<Duplex>; close: () => Promise<void> }> {
      const binding = snapshotWorkerNodeCarrierBinding(
        options.store.get(request.environmentId),
        UNSUPPORTED_NODE_PORTAL_MESSAGE,
        request.ownerEpoch,
      );
      const capturedRuntime = runtime;
      if (!capturedRuntime) {
        throw new Error(UNSUPPORTED_NODE_PORTAL_MESSAGE);
      }
      const portal: ActiveNodePortal = {
        binding,
        controller: new AbortController(),
        streams: new Set(),
        closed: false,
      };
      activePortals.add(portal);
      try {
        await findCurrentNode(binding, capturedRuntime, portal.controller.signal);
        return {
          connect: () => connectPortal(portal, request.remotePort),
          close: () => closePortal(portal),
        };
      } catch (error) {
        await closePortal(portal);
        throw error;
      }
    },
    async stop(environmentId: string, ownerEpoch?: number): Promise<void> {
      await Promise.all(
        [...activePortals]
          .filter(
            (portal) =>
              portal.binding.environmentId === environmentId &&
              (ownerEpoch === undefined || portal.binding.ownerEpoch === ownerEpoch),
          )
          .map(closePortal),
      );
    },
    async stopAll(): Promise<void> {
      await Promise.all([...activePortals].map(closePortal));
    },
  };
}

export type WorkerNodePortalCarrier = ReturnType<typeof createWorkerNodePortalCarrier>;
