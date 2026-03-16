import { describe, expect, it } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks();

const { callGateway } = await import("./call.js");
const { probeGateway } = await import("./probe.js");

describe("probeGateway auth integration", () => {
  it("keeps direct local authenticated status RPCs device-bound", async () => {
    const token =
      typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
        ? ((testState.gatewayAuth as { token?: string }).token ?? "")
        : "";
    expect(token).toBeTruthy();

    await withGatewayServer(async ({ port }) => {
      const status = await callGateway({
        url: `ws://127.0.0.1:${port}`,
        token,
        method: "status",
        timeoutMs: 5_000,
      });

      expect(status).toBeTruthy();
    });
  });

  it("keeps detail RPCs available for local authenticated probes", async () => {
    const token =
      typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
        ? ((testState.gatewayAuth as { token?: string }).token ?? "")
        : "";
    expect(token).toBeTruthy();

    await withGatewayServer(async ({ port }) => {
      const result = await probeGateway({
        url: `ws://127.0.0.1:${port}`,
        auth: { token },
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.health).not.toBeNull();
      expect(result.status).not.toBeNull();
      expect(result.configSnapshot).not.toBeNull();
    });
  });
});
