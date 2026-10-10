import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { clearLinkPreviews, loadLinkPreview } from "./link-preview.ts";

function fixture() {
  const request = vi.fn().mockResolvedValue({ title: "Field guide" });
  const state = { request, connectionGeneration: 1, recoveryScope: "first" };
  return { request, state, client: state as unknown as GatewayBrowserClient };
}
afterEach(() => vi.useRealTimers());

describe("shared public link metadata", () => {
  it("shares browser-card and hover subscribers without sharing navigation fragments", async () => {
    const { client, request } = fixture();
    const pending = createDeferred<unknown>();
    request.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const browser = loadLinkPreview(client, "https://example.com/page#one");
    const hover = loadLinkPreview(client, "https://example.com/page#two", controller.signal);
    const rejected = expect(hover).rejects.toBeDefined();
    controller.abort();
    await rejected;
    expect(request.mock.calls[0]?.[2].signal.aborted).toBe(false);
    pending.resolve({ title: "Shared" });
    expect(await browser).toMatchObject({ title: "Shared" });
    expect(await loadLinkPreview(client, "https://example.com/page#three")).toMatchObject({
      title: "Shared",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toEqual({ url: "https://example.com/page" });
  });

  it.each(["connectionGeneration", "recoveryScope", "policy"])(
    "retires late replies after %s changes",
    async (change) => {
      const { client, request, state } = fixture();
      const pending = createDeferred<unknown>();
      request.mockReturnValueOnce(pending.promise);
      const old = loadLinkPreview(client, "https://example.com/page");
      if (change === "connectionGeneration") {
        state.connectionGeneration++;
      } else if (change === "recoveryScope") {
        state.recoveryScope = "new";
      } else {
        clearLinkPreviews(client);
      }
      expect(await loadLinkPreview(client, "https://example.com/page")).toMatchObject({
        title: "Field guide",
      });
      pending.resolve({ title: "Old authority" });
      expect(await old).toEqual({});
      expect(await loadLinkPreview(client, "https://example.com/page")).toMatchObject({
        title: "Field guide",
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds untrusted presentation and never returns remote images", async () => {
    const { client, request } = fixture();
    request.mockResolvedValue({
      title: "x".repeat(200),
      description: "y".repeat(500),
      imageDataUrl: "https://tracker.example/image.png",
      faviconDataUrl: "data:image/svg+xml;base64,AAAA",
    });
    const preview = await loadLinkPreview(client, "https://example.com");
    expect(preview.title).toHaveLength(180);
    expect(preview.description).toHaveLength(400);
    expect(preview.imageDataUrl).toBeUndefined();
    expect(preview.faviconDataUrl).toBeUndefined();
  });

  it("backs off empty metadata but retries transport failures", async () => {
    vi.useFakeTimers();
    const { client, request } = fixture();
    request.mockResolvedValueOnce({});
    expect(await loadLinkPreview(client, "https://example.com")).toEqual({});
    expect(await loadLinkPreview(client, "https://example.com")).toEqual({});
    expect(request).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_001);
    request.mockRejectedValueOnce(new Error("disconnected"));
    expect(await loadLinkPreview(client, "https://example.com")).toEqual({});
    expect(await loadLinkPreview(client, "https://example.com")).toMatchObject({
      title: "Field guide",
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
