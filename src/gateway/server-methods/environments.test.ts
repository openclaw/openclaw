import { describe, expect, it, vi } from "vitest";
import type { NodeSession } from "../node-registry.js";
import { ErrorCodes } from "../protocol/index.js";
import { environmentsHandlers, listEnvironmentSummaries } from "./environments.js";

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
  }?,
];

const connectedNode = {
  nodeId: "ios-node-1",
  clientId: "ios-client",
  displayName: "iPhone",
  caps: ["canvas"],
  commands: ["camera.capture"],
} as NodeSession;

function makeContext(nodes: NodeSession[] = []) {
  return {
    nodeRegistry: {
      listConnected: vi.fn(() => nodes),
    },
  };
}

describe("environment discovery handlers", () => {
  it("lists local, gateway, connected node, and managed candidates", () => {
    expect(listEnvironmentSummaries([connectedNode])).toEqual([
      {
        id: "local",
        type: "local",
        label: "Local Gateway host",
        status: "available",
        capabilities: [
          "agent.run",
          "approvals",
          "models",
          "sessions",
          "tools.catalog",
          "tools.effective",
        ],
      },
      {
        id: "gateway",
        type: "gateway",
        label: "Current Gateway",
        status: "available",
        capabilities: ["gateway.events", "gateway.identity", "gateway.rpc", "node.discovery"],
      },
      {
        id: "node:ios-node-1",
        type: "node",
        label: "iPhone",
        status: "available",
        capabilities: ["canvas", "command:camera.capture", "node.invoke"],
      },
      {
        id: "managed:testbox",
        type: "managed",
        label: "Managed Testbox",
        status: "unavailable",
        capabilities: [],
      },
    ]);
  });

  it("serves environments.list from connected node state", async () => {
    const respond = vi.fn();

    await environmentsHandlers["environments.list"]({
      req: { type: "req", id: "req-env-list", method: "environments.list" },
      params: {},
      respond,
      context: makeContext([connectedNode]) as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, {
      environments: expect.arrayContaining([
        expect.objectContaining({ id: "local", status: "available" }),
        expect.objectContaining({ id: "node:ios-node-1", type: "node" }),
        expect.objectContaining({ id: "managed:testbox", status: "unavailable" }),
      ]),
    });
  });

  it("returns status for known environments and rejects unknown ids", async () => {
    const context = makeContext([connectedNode]);
    const respond = vi.fn();

    await environmentsHandlers["environments.status"]({
      req: { type: "req", id: "req-env-status", method: "environments.status" },
      params: { environmentId: "node:ios-node-1" },
      respond,
      context: context as never,
      client: null,
      isWebchatConnect: () => false,
    });

    await environmentsHandlers["environments.status"]({
      req: { type: "req", id: "req-env-status-missing", method: "environments.status" },
      params: { environmentId: "node:missing" },
      respond,
      context: context as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond.mock.calls[0]).toEqual([
      true,
      expect.objectContaining({ id: "node:ios-node-1", status: "available" }),
    ]);
    const missingCall = respond.mock.calls[1] as RespondCall | undefined;
    expect(missingCall?.[0]).toBe(false);
    expect(missingCall?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(missingCall?.[2]?.message).toBe("unknown environmentId");
  });

  it("rejects invalid params", async () => {
    const respond = vi.fn();

    await environmentsHandlers["environments.status"]({
      req: { type: "req", id: "req-env-status-invalid", method: "environments.status" },
      params: {},
      respond,
      context: makeContext() as never,
      client: null,
      isWebchatConnect: () => false,
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid environments.status params");
  });
});
