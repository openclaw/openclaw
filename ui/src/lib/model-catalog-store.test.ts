import { describe, expect, it } from "vitest";
import type { ModelCatalogResult } from "../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { loadModelCatalog } from "./model-catalog-store.ts";

const prepared = { id: "prepared", name: "Prepared", provider: "example" };
const published = { id: "published", name: "Published", provider: "example" };

describe("direct model catalog reads", () => {
  it("reads the latest published generation without a timer or discovery", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared] })
      .mockResolvedValueOnce({ models: [published] });
    const client = createTestGatewayClient(request);
    expect((await loadModelCatalog(client, { agentId: "writer" })).models).toEqual([prepared]);
    expect((await loadModelCatalog(client, { agentId: "writer" })).models).toEqual([published]);
    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      { view: "configured", agentId: "writer" },
      { view: "configured", agentId: "writer" },
    ]);
  });

  it("keeps agent, saved-session and draft-account results separate", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared] })
      .mockResolvedValueOnce({ models: [published] })
      .mockResolvedValueOnce({
        models: [],
        accountSelection: { kind: "automatic", label: "Automatic" },
      });
    const client = createTestGatewayClient(request);
    const agent = await loadModelCatalog(client, { agentId: " writer " });
    const saved = await loadModelCatalog(client, {
      agentId: "writer",
      sessionKey: "agent:writer:saved",
    });
    const draft = await loadModelCatalog(client, {
      agentId: "writer",
      authProfileId: "personal:reader:example:one",
    });
    expect(agent.models).toEqual([prepared]);
    expect(saved.models).toEqual([published]);
    expect(draft).toEqual({
      models: [],
      accountSelection: { kind: "automatic", label: "Automatic" },
    });
    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      { view: "configured", agentId: "writer" },
      { view: "configured", agentId: "writer", sessionKey: "agent:writer:saved" },
      { view: "configured", agentId: "writer", authProfileId: "personal:reader:example:one" },
    ]);
  });

  it("preserves explicit view and refresh without invalidating command metadata", async () => {
    const request = createGatewayRequestMock(async () => ({ models: [published] }));
    const client = createTestGatewayClient(request);
    expect(
      (await loadModelCatalog(client, { view: "provider-config", refresh: true })).models,
    ).toEqual([published]);
    expect(request).toHaveBeenCalledExactlyOnceWith("models.list", {
      view: "provider-config",
      refresh: true,
    });
  });

  it("preserves failed refresh facts, successful empty results and recovery", async () => {
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce({ models: [prepared], refreshFailed: true })
      .mockResolvedValueOnce({ models: [] })
      .mockRejectedValueOnce(new Error("transport closed"))
      .mockResolvedValueOnce({ models: [published] });
    const client = createTestGatewayClient(request);
    expect(await loadModelCatalog(client, {})).toEqual({ models: [prepared], refreshFailed: true });
    expect(await loadModelCatalog(client, {})).toEqual({ models: [] });
    await expect(loadModelCatalog(client, {})).rejects.toThrow("transport closed");
    expect(await loadModelCatalog(client, {})).toEqual({ models: [published] });
  });

  it("does not let one consumer cancel another consumer's request", async () => {
    let finishSecond!: (result: ModelCatalogResult) => void;
    const first = new AbortController();
    const second = new AbortController();
    const request = createGatewayRequestMock((_method, _params, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected caller cancellation signal");
      }
      return new Promise<ModelCatalogResult>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(reason), { once: true });
        if (signal === second.signal) {
          finishSecond = resolve;
        }
      });
    });
    const client = createTestGatewayClient(request);
    const retired = loadModelCatalog(client, { agentId: "writer", signal: first.signal });
    const active = loadModelCatalog(client, { agentId: "writer", signal: second.signal });
    const reason = new DOMException("Page retired", "AbortError");
    first.abort(reason);
    await expect(retired).rejects.toBe(reason);
    expect(second.signal.aborted).toBe(false);
    finishSecond({ models: [published] });
    expect(await active).toEqual({ models: [published] });
  });

  it("rejects an already retired request before transport", async () => {
    const request = createGatewayRequestMock();
    const controller = new AbortController();
    const reason = new DOMException("Page retired", "AbortError");
    controller.abort(reason);
    await expect(
      loadModelCatalog(createTestGatewayClient(request), { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });
});
