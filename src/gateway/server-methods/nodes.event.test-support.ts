import { onTestFinished, vi } from "vitest";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createGatewayNodeSessionRuntime } from "../server-node-session-runtime.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeEventHandlers } from "./nodes.event.js";
import { invokeNodeRequest } from "./nodes.invoke.test-support.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export class NodeEventHarness {
  binding = { identity: "identity-1", generation: "generation-1" };
  resolvePairing = vi.fn(async () => this.binding);
  broadcast = vi.fn();
  warn = vi.fn();
  runtime = createGatewayNodeSessionRuntime({
    broadcast: this.broadcast,
    resolveCurrentPairingState: this.resolvePairing,
    isPairingStateCurrent: () => true,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
  context = {
    ...this.runtime,
    broadcast: this.broadcast,
    logGateway: { warn: this.warn },
  } as unknown as GatewayRequestHandlerOptions["context"];
  nodeRegistry = this.runtime.nodeRegistry;
  register(connId: string, nodeId = "node-1", clientId = "openclaw-macos", platform = "darwin") {
    const client = createWorkerSupervisorNodeClient(connId);
    Object.assign(client.connect, {
      role: "node",
      scopes: [],
      commands: [],
      device: { id: nodeId },
    });
    Object.assign(client.connect.client, { id: clientId, platform });
    this.nodeRegistry.register(client, {
      pairingIdentity: this.binding.identity,
      pairingGeneration: this.binding.generation,
    });
    onTestFinished(() => {
      this.nodeRegistry.unregister(connId);
    });
    return client;
  }
  send(client: GatewayWsClient, payload: unknown, event = "node.desktop.availability") {
    return invokeNodeRequest(
      nodeEventHandlers["node.event"]!,
      this.context,
      client,
      "node.event",
      { event, payload },
      "desktop-state",
    );
  }
  changes = () =>
    this.broadcast.mock.calls
      .filter(([event]) => event === "node.runnerInventory.changed")
      .map(([, payload]) => payload);
  node = () => this.nodeRegistry.get("node-1");
  active = () => this.nodeRegistry.getActiveNode();
}
