import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { loadModels } from "./models.ts";

describe("loadModels", () => {
  it("requests the configured model list view", async () => {
    const request = vi.fn(async () => ({
      models: [
        { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", provider: "minimax" },
      ],
    }));

    const models = await loadModels({ request } as unknown as GatewayBrowserClient);

    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
    expect(models).toEqual([
      { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", provider: "minimax" },
    ]);
  });

  it("forwards the agentId to scope the per-agent allowlist when provided", async () => {
    const request = vi.fn(async () => ({ models: [] }));

    await loadModels({ request } as unknown as GatewayBrowserClient, { agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "writer",
    });
  });

  it("omits an empty agentId option to keep gateway requests backwards compatible", async () => {
    const request = vi.fn(async () => ({ models: [] }));

    await loadModels({ request } as unknown as GatewayBrowserClient, { agentId: "   " });

    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
  });
});
