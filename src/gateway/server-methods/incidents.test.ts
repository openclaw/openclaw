import { describe, expect, it, vi } from "vitest";
import { IncidentManager } from "../incident-manager.js";

const broadcastDashboardDeltaMock = vi.hoisted(() => vi.fn());

vi.mock("./dashboard.js", () => ({
  broadcastDashboardDelta: broadcastDashboardDeltaMock,
}));

async function loadHandlers() {
  return (await import("./incidents.js")).incidentsHandlers;
}

function createContext() {
  return {
    incidentManager: new IncidentManager(),
    execApprovalManager: {
      listPending: () => [],
    },
    nodeRegistry: {
      listConnected: () => [],
    },
    hasConnectedMobileNode: () => false,
    broadcast: vi.fn(),
    logGateway: {
      warn: vi.fn(),
    },
  };
}

function seedIncident(context: ReturnType<typeof createContext>) {
  context.incidentManager.sync([
    {
      id: "runtime:queue-pressure",
      source: "runtime",
      severity: "warn",
      title: "Runtime queue pressure",
      detail: "Queue is building up.",
      metadata: {
        actionTab: "instances",
        actionLabel: "Open runtime",
      },
    },
  ]);
}

describe("incident handlers", () => {
  it("lists active incidents", async () => {
    const handlers = await loadHandlers();
    const context = createContext();
    seedIncident(context);
    const respond = vi.fn();

    await handlers["incident.list"]({
      params: {},
      respond,
      context: context as Parameters<(typeof handlers)["incident.list"]>[0]["context"],
    } as Parameters<(typeof handlers)["incident.list"]>[0]);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        summary: expect.objectContaining({ active: 1, open: 1 }),
        incidents: [expect.objectContaining({ id: "runtime:queue-pressure", status: "open" })],
      }),
      undefined,
    );
  });

  it("acks and resolves incidents", async () => {
    const handlers = await loadHandlers();
    const context = createContext();
    seedIncident(context);
    const respond = vi.fn();
    const client = {
      connect: {
        client: {
          id: "operator-1",
          displayName: "Ops",
        },
      },
    };

    await handlers["incident.ack"]({
      params: { id: "runtime:queue-pressure" },
      respond,
      context: context as Parameters<(typeof handlers)["incident.ack"]>[0]["context"],
      client: client as Parameters<(typeof handlers)["incident.ack"]>[0]["client"],
    } as Parameters<(typeof handlers)["incident.ack"]>[0]);

    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        incident: expect.objectContaining({
          id: "runtime:queue-pressure",
          status: "acked",
          acknowledgedBy: "Ops",
        }),
      }),
      undefined,
    );
    expect(broadcastDashboardDeltaMock).toHaveBeenCalledTimes(1);

    await handlers["incident.resolve"]({
      params: { id: "runtime:queue-pressure" },
      respond,
      context: context as Parameters<(typeof handlers)["incident.resolve"]>[0]["context"],
      client: client as Parameters<(typeof handlers)["incident.resolve"]>[0]["client"],
    } as Parameters<(typeof handlers)["incident.resolve"]>[0]);

    expect(respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        incident: expect.objectContaining({
          id: "runtime:queue-pressure",
          status: "resolved",
          resolvedBy: "Ops",
        }),
      }),
      undefined,
    );
    expect(broadcastDashboardDeltaMock).toHaveBeenCalledTimes(2);
  });
});
