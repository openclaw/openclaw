import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { handleNodeInvokeResult } from "../server-methods/nodes.handlers.invoke-result.js";
import { COMPUTER_USE, EXECUTION_ID, createHarness } from "./computer-transport.test-support.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it.each(["current", "lease", "epoch", "connection", "pairing", "after-handler-load"] as const)(
  "settles shared desktop shutdown only for its captured live owner: %s",
  async (boundary) => {
    const h = createHarness(true);
    const frames: Array<{ id: string; nodeId: string; command: string; paramsJSON: string }> = [];
    const client = makeClient("desktop-connection", "desktop-node", [], {
      clientId: "node-host",
      version: "test",
      platform: "linux",
      commands: ["screen.snapshot", "computer.act"],
      computerUse: COMPUTER_USE,
    });
    client.connect.role = "node";
    client.connect.scopes = [];
    client.connect.client.deviceFamily = "Linux";
    client.socket.send = (value) => {
      const frame = JSON.parse(String(value));
      if (frame.event === "node.invoke.request") {
        frames.push(frame.payload);
      }
    };
    const registry = new NodeRegistry({
      resolveCurrentPairingState: async () => ({ identity: "paired", generation: "pairing-1" }),
    });
    const pairing = { pairingIdentity: "paired", pairingGeneration: "pairing-1" };
    h.state.node = registry.register(client, pairing);
    const context = h.state.context;
    if (!context) {
      throw new Error("expected computer Gateway context");
    }
    context.nodeRegistry = registry;
    context.logGateway = createSubsystemLogger("gateway/computer-shutdown-test");
    const handlerEntered = createDeferred();
    const resumeHandler = createDeferred();
    const respond = async (index: number) => {
      const frame = frames[index]!;
      const reply = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `reply-${index}`,
          method: "node.invoke.result",
          params: { id: frame.id, nodeId: frame.nodeId, ok: true, payloadJSON: "{}" },
        },
        respond: reply,
        client,
        context,
        isWebchatConnect: () => false,
        extraHandlers: {
          "node.invoke.result": async (options) => {
            if (index === 1 && boundary === "after-handler-load") {
              handlerEntered.resolve();
              await resumeHandler.promise;
            }
            await handleNodeInvokeResult(options);
          },
        },
      });
      return reply;
    };
    const { prepared, transport } = await h.prepare();
    let closing: Promise<void> | undefined;
    try {
      const observed = transport.invoke({
        nodeId: "desktop-node",
        command: "screen.snapshot",
        commandParams: { executionId: EXECUTION_ID, format: "png" },
      });
      void observed.catch(() => {});
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(await respond(0)).toHaveBeenCalledWith(true, { ok: true }, undefined);
      await observed;
      const executionId = JSON.parse(frames[0]!.paramsJSON).executionId;
      expect(executionId).not.toBe(EXECUTION_ID);

      markGatewayRestartDraining();
      closing = prepared.close("shutdown");
      void closing.catch(() => {});
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]!.command).toBe("computer.act");
      expect(JSON.parse(frames[1]!.paramsJSON)).toEqual({
        action: "__close_execution",
        executionId,
        reason: "shutdown",
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      if (boundary === "lease") {
        h.state.environment = { ...h.state.environment, leaseId: "replacement" };
      } else if (boundary === "epoch") {
        h.state.environment = { ...h.state.environment, ownerEpoch: 8 };
      } else if (boundary === "connection") {
        registry.register({ ...client, connId: "replacement" }, pairing);
      } else if (boundary === "pairing") {
        registry.updateSurface(
          "desktop-node",
          { commands: h.state.node.commands },
          {
            expectedConnId: client.connId,
            expectedPairingIdentity: "paired",
            expectedPairingGeneration: "pairing-1",
            nextPairingGeneration: "pairing-replaced",
          },
        );
      }
      const response = respond(1);
      if (boundary === "after-handler-load") {
        await awaitGateBeforeSettlement(
          handlerEntered.promise,
          response,
          "cleanup reply was rejected before reaching its handler",
        );
        h.state.environment = { ...h.state.environment, leaseId: "replacement" };
        resumeHandler.resolve();
        expect(await response).toHaveBeenCalledWith(true, { ok: true, ignored: true }, undefined);
      } else if (boundary === "current") {
        expect(await response).toHaveBeenCalledWith(true, { ok: true }, undefined);
        await closing;
      } else {
        expect(await response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(frames).toHaveLength(2);
    } finally {
      resumeHandler.resolve();
      registry.unregister(client.connId);
      registry.unregister("replacement");
      await (closing ?? prepared.close("test finished")).catch(() => {});
    }
  },
);
