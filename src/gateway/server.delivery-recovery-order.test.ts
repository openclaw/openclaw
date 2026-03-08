import { afterEach, describe, expect, it, vi } from "vitest";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  let releaseSidecarsGate: (() => void) | undefined;
  let sidecarsGate!: Promise<void>;
  const resetSidecarsGate = () => {
    sidecarsGate = new Promise<void>((resolve) => {
      releaseSidecarsGate = resolve;
    });
  };
  resetSidecarsGate();
  return {
    order,
    resetSidecarsGate,
    releaseSidecars: () => releaseSidecarsGate?.(),
    startGatewaySidecars: vi.fn(async () => {
      order.push("sidecars:start");
      await sidecarsGate;
      order.push("sidecars:done");
      return { browserControl: null, pluginServices: null };
    }),
    recoverPendingDeliveries: vi.fn(async () => {
      order.push("recovery");
      return { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 };
    }),
    deliverOutboundPayloads: vi.fn(async () => []),
  };
});

vi.mock("./server-startup.js", async () => {
  const actual = await vi.importActual<typeof import("./server-startup.js")>("./server-startup.js");
  return {
    ...actual,
    startGatewaySidecars: mocks.startGatewaySidecars,
  };
});

vi.mock("../infra/outbound/delivery-queue.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/delivery-queue.js")>(
    "../infra/outbound/delivery-queue.js",
  );
  return {
    ...actual,
    recoverPendingDeliveries: mocks.recoverPendingDeliveries,
  };
});

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

await import("../infra/outbound/delivery-queue.js");
await import("../infra/outbound/deliver.js");
const { startGatewayServer } = await import("./server.js");

installGatewayTestHooks();

afterEach(() => {
  mocks.order.length = 0;
  mocks.resetSidecarsGate();
  mocks.startGatewaySidecars.mockClear();
  mocks.recoverPendingDeliveries.mockClear();
  mocks.deliverOutboundPayloads.mockClear();
});

describe("startGatewayServer delivery recovery", () => {
  it("starts sidecars before replaying queued deliveries", async () => {
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;

    const port = await getFreePort();
    const startup = startGatewayServer(port);
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

    try {
      await vi.waitFor(() => {
        expect(mocks.startGatewaySidecars).toHaveBeenCalledTimes(1);
      });

      expect(mocks.recoverPendingDeliveries).not.toHaveBeenCalled();

      mocks.releaseSidecars();
      server = await startup;

      await vi.waitFor(() => {
        expect(mocks.recoverPendingDeliveries).toHaveBeenCalledTimes(1);
      });

      expect(mocks.order).toEqual(["sidecars:start", "sidecars:done", "recovery"]);
      expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    } finally {
      mocks.releaseSidecars();
      if (!server) {
        try {
          server = await startup;
        } catch {
          server = undefined;
        }
      }
      if (server) {
        await server.close({ reason: "test complete" });
      }
    }
  });
});
