import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { rawDataToString } from "../../../packages/gateway-client/src/websocket-data.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_DESKTOP_STREAM_COMMAND } from "../../infra/node-commands.js";
import {
  invokeNodeDesktopStream,
  invokeNodeWorkerDesktopStream,
} from "../../node-host/desktop-stream-command.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { NodeRegistry } from "../node-registry.js";
import { environmentsHandlers } from "../server-methods/environments.js";
import { createWorkerNodeDesktopCarrier } from "../worker-environments/node-desktop-carrier.js";
import { createNodeWorkerBundleTestNode } from "../worker-environments/node-worker-bundle.test-support.js";
import * as workerSupport from "../worker-environments/service.test-support.js";
import {
  handlePeerTeardownError,
  createSocketServer,
  listenLoopback,
} from "./desktop.test-support.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import {
  connectRfbObserver,
  RFB_VERSION as VERSION,
  startObserveGateway,
} from "./observe.test-support.js";
import { createDesktopSessionRegistry } from "./session-registry.js";
import { SocketReader } from "./socket-reader.test-support.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function startRfbHarness(expectedStreams: number, endAfterRequest?: Promise<void>) {
  let connectionCount = 0;
  let completedStreams = 0;
  const done = createDeferred();
  const { server, peers } = createSocketServer(cleanups, (socket) => {
    // Session teardown destroys client sockets; the synthetic server owns the matching resets.
    socket.on("error", handlePeerTeardownError);
    connectionCount += 1;
    const reader = new SocketReader(socket);
    void (async () => {
      try {
        socket.write(VERSION);
        expect(await reader.readExactly(VERSION.length)).toEqual(VERSION);
        socket.write(Buffer.from([1, 2]));
        expect(await reader.readExactly(1)).toEqual(Buffer.from([2]));
        socket.write(Buffer.alloc(16, 7));
        expect(await reader.readExactly(16)).toHaveLength(16);
        socket.write(Buffer.alloc(4));

        expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
        socket.write(Buffer.from("pixel-update", "ascii"));
        const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
        expect(await reader.readExactly(framebufferRequest.length)).toEqual(framebufferRequest);
        completedStreams += 1;
        if (completedStreams === expectedStreams) {
          done.resolve();
        }
        if (endAfterRequest) {
          await endAfterRequest;
          socket.end(Buffer.from("terminal-pixel-update", "ascii"));
        }
      } catch (error) {
        done.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
  const port = await listenLoopback(server);
  return { completion: done.promise, connectionCount: () => connectionCount, peers, port };
}

async function openViewOnlyObserver(gatewayUrl: string, wsPath: string): Promise<WebSocket> {
  const { ws, nextFrame } = await connectRfbObserver(cleanups, `${gatewayUrl}${wsPath}`);
  expect(await nextFrame()).toEqual(Buffer.alloc(4));
  expect(await nextFrame()).toEqual(Buffer.from("pixel-update", "ascii"));

  const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
  const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
  ws.send(Buffer.concat([keyEvent, framebufferRequest]));
  return ws;
}

async function trackInvocation<T>(results: boolean[], invoke: () => Promise<T>) {
  try {
    const result = await invoke();
    results.push(true);
    return result;
  } catch (error) {
    results.push(false);
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function workerNodeProof(nodeId: string): NodeWorkerSupervisorNodeProof {
  return createNodeWorkerBundleTestNode({
    nodeId,
    connId: "worker-conn-1",
    pairingIdentity: "worker-identity-1",
    pairingGeneration: "worker-generation-1",
    workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
  });
}

async function observeEnvironmentDesktop(
  workerEnvironmentService: ReturnType<typeof workerSupport.createService>,
  environmentId: string,
) {
  const respond = vi.fn();
  await environmentsHandlers["desktop.observe"]?.({
    params: { source: { kind: "environment", environmentId }, control: false },
    respond,
    context: { workerEnvironmentService },
  } as never);
  const [ok, result, error] = respond.mock.calls.at(0) ?? [];
  expect([ok, error]).toEqual([true, undefined]);
  return result as { transport: "rfb"; wsPath: string; control: boolean };
}

describe.each(["node", "worker"] as const)("%s desktop observe integration", (kind) => {
  if (kind === "worker") {
    workerSupport.setupWorkerEnvironmentServiceSuite();
  }
  it.each(["owner-stop", "peer-eof"])(
    "relays concurrent viewers, filters input and settles on %s",
    async (closeMode) => {
      const endAfterRequest = createDeferred();
      const rfb = await startRfbHarness(
        3,
        closeMode === "peer-eof" ? endAfterRequest.promise : undefined,
      );
      const completedInvocations: boolean[] = [];
      const desktopRegistry = createDesktopSessionRegistry();
      const streamBroker = createNodeDesktopStreamBroker();
      cleanups.push(async () => desktopRegistry.stopAll());
      let gatewayUrl = "";
      let nodeRegistry: NodeRegistry;
      let observe: () => Promise<{ wsPath: string }>;
      let stop: () => Promise<unknown>;
      let verifyStopped: (() => void) | undefined;
      if (kind === "node") {
        const nodeSession = {
          nodeId: "node-1",
          connId: "conn-1",
          pairingGeneration: "generation-1",
          platform: "linux",
          deviceFamily: "Linux",
          commands: [NODE_DESKTOP_STREAM_COMMAND],
        };
        nodeRegistry = {
          get: () => nodeSession,
          getForPairingGeneration: (_nodeId: string, generation: string) =>
            generation === nodeSession.pairingGeneration ? nodeSession : undefined,
          isConnectionCurrentPairingState: async (connId: string) => connId === nodeSession.connId,
          invoke: async (request: {
            params?: unknown;
            signal?: AbortSignal;
            onProgress?: (chunk: string) => void;
          }) => {
            return trackInvocation(completedInvocations, async () => {
              await invokeNodeDesktopStream({
                paramsJSON: JSON.stringify(request.params),
                gatewayUrl,
                config: { enabled: true, port: rfb.port },
                signal: request.signal ?? new AbortController().signal,
                emitStatus: async (status) => request.onProgress?.(status),
              });
              return { ok: true };
            });
          },
        } as unknown as NodeRegistry;

        const service = createNodeDesktopService({
          getConfig: () => ({}),
          nodeRegistry,
          desktopRegistry,
          streamBroker,
        });
        observe = () =>
          service.observe({
            nodeId: nodeSession.nodeId,
            control: false,
            credentials: { password: "memory-only-password" },
          });
        stop = () => service.stopNode(nodeSession.nodeId);
      } else {
        const passwordFilePath = path.join(workerSupport.testState.root, "vnc.password");
        await fs.writeFile(passwordFilePath, "memory-only-password\n", { mode: 0o600 });
        const record = await workerSupport.seedReadyNodeDesktop("worker-node-desktop-byte-flow", {
          ...workerSupport.DESKTOP,
          port: rfb.port,
          passwordFilePath,
        });
        if (!record.nodeDeviceId) {
          throw new Error("expected durable worker node id");
        }

        const proof = workerNodeProof(record.nodeDeviceId);
        nodeRegistry = {
          getForPairingGeneration: (nodeId: string, generation: string) =>
            nodeId === proof.nodeId && generation === proof.pairingGeneration ? proof : undefined,
          isConnectionCurrentPairingState: async (connId: string) => connId === proof.connId,
        } as unknown as NodeRegistry;
        const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
          expect(request.command).toBe(NODE_WORKER_DESKTOP_STREAM_COMMAND);
          if (!request.isDispatchAuthorized()) {
            return { ok: false, error: { code: "STALE", message: "desktop owner is stale" } };
          }
          return trackInvocation(completedInvocations, async () => {
            await invokeNodeWorkerDesktopStream({
              paramsJSON: JSON.stringify(request.params),
              gatewayUrl,
              signal: request.signal ?? new AbortController().signal,
            });
            return { ok: true, payload: null };
          });
        });
        const transport: NodeWorkerSupervisorTransport = {
          getCurrentNode: async (nodeId) => (proof.nodeId === nodeId ? proof : undefined),
          listCurrentNodes: async () => [proof],
          hasCurrentRunner: (nodeId) => nodeId === proof.nodeId,
          isCurrent: (candidate) =>
            candidate.nodeId === proof.nodeId &&
            candidate.connId === proof.connId &&
            candidate.pairingGeneration === proof.pairingGeneration,
          invoke,
        };
        const carrier = createWorkerNodeDesktopCarrier({
          store: workerSupport.testState.store,
          desktopRegistry,
        });
        carrier.bindRuntime({ transport, streamBroker });
        const workerService = workerSupport.createService(workerSupport.createProvider(), {
          nodeDesktopCarrier: carrier,
          now: Date.now,
        });

        observe = () => observeEnvironmentDesktop(workerService, record.environmentId);
        stop = () => workerService.destroy(record.environmentId);
        verifyStopped = () => {
          expect(workerSupport.testState.store.get(record.environmentId)?.state).toBe("destroyed");
          expect(invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
        };
      }
      gatewayUrl = await startObserveGateway(cleanups, desktopRegistry, (req, socket, head) =>
        streamBroker.handleUpgrade(req, socket, head, nodeRegistry),
      );
      const observers = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const observed = await observe();
          expect(observed).toMatchObject(
            kind === "node" ? { auth: "vnc-password" } : { transport: "rfb", control: false },
          );
          return await openViewOnlyObserver(gatewayUrl, observed.wsPath);
        }),
      );
      expect(observers.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
      await expect(rfb.completion).resolves.toBeUndefined();
      await vi.waitFor(() => expect(rfb.connectionCount()).toBe(3));
      if (closeMode === "peer-eof") {
        const terminalFrames = observers.map((ws) => {
          const received: string[] = [];
          ws.on("message", (data) => received.push(rawDataToString(data)));
          return received;
        });
        endAfterRequest.resolve();
        await vi.waitFor(() => expect(completedInvocations).toEqual(observers.map(() => true)));
        await vi.waitFor(() =>
          expect(observers.every((ws) => ws.readyState === WebSocket.CLOSED)).toBe(true),
        );
        expect(terminalFrames.map((frames) => frames.join(""))).toEqual(
          observers.map(() => "terminal-pixel-update"),
        );
        if (kind === "worker") {
          await stop();
        }
      } else {
        const closed = observers.map((observer) => once(observer, "close"));
        await stop();
        await Promise.all(closed);
        await vi.waitFor(() => expect(rfb.peers.size).toBe(0));
      }
      verifyStopped?.();
    },
  );
});
