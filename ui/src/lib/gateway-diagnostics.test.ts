import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { loadGatewayDiagnostics } from "./gateway-diagnostics.ts";

describe("loadGatewayDiagnostics", () => {
  it("reads the published default view with caller cancellation", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "diagnostics.lanes") {
        return { lanes: [], dynamic: null };
      }
      return {};
    });

    const controller = new AbortController();
    await loadGatewayDiagnostics(
      { request } as unknown as GatewayBrowserClient,
      "writer",
      controller.signal,
    );

    expect(request).toHaveBeenCalledWith(
      "models.list",
      { view: "default", agentId: "writer" },
      { signal: controller.signal },
    );
  });

  it("keeps diagnostics available without requesting models before agent selection", async () => {
    const request = vi.fn(async (method: string) =>
      method === "diagnostics.lanes" ? { lanes: [], dynamic: null } : {},
    );

    const result = await loadGatewayDiagnostics(
      { request } as unknown as GatewayBrowserClient,
      null,
    );

    expect(result.models).toEqual([]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "diagnostics.lanes",
      "status",
      "health",
      "last-heartbeat",
    ]);
  });
});
