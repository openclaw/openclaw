import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { clearLinkPreviews, loadLinkPreview } from "./link-preview.ts";

const fieldGuide = { title: "Field guide" };
function fixture() {
  const request = vi.fn().mockResolvedValue(fieldGuide);
  const state = { request, connected: true, connectionGeneration: 1, recoveryScope: "first" };
  const client = state as unknown as GatewayBrowserClient;
  const load = (fragment = "", signal?: AbortSignal) =>
    loadLinkPreview(client, `https://example.com/page${fragment}`, signal);
  return { request, state, client, load };
}
afterEach(() => vi.useRealTimers());

describe("shared public link metadata", () => {
  it("shares browser-card and hover subscribers without sharing navigation fragments", async () => {
    const { load, request } = fixture();
    const pending = createDeferred<unknown>();
    request.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const browser = load("#one");
    const hover = load("#two", controller.signal);
    const rejected = expect(hover).rejects.toBeDefined();
    controller.abort();
    await rejected;
    expect(request.mock.calls[0]?.[2].signal.aborted).toBe(false);
    pending.resolve({ title: "Shared" });
    expect(await browser).toMatchObject({ title: "Shared" });
    expect(await load("#three")).toMatchObject({ title: "Shared" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toEqual({ url: "https://example.com/page" });
  });

  it.each([
    ["connectionGeneration", 2],
    ["recoveryScope", "new"],
    ["policy", null],
  ] as const)("retires late replies after %s changes", async (change, value) => {
    const { client, load, request, state } = fixture();
    const pending = createDeferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    const old = load();
    if (change === "policy") {
      clearLinkPreviews(client);
    } else {
      Object.assign(state, { [change]: value });
    }
    expect(await load()).toMatchObject(fieldGuide);
    pending.resolve({ title: "Old authority" });
    expect(await old).toEqual({});
    expect(await load()).toMatchObject(fieldGuide);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds untrusted presentation and never returns remote images", async () => {
    const { load, request } = fixture();
    request.mockResolvedValue({
      title: "x".repeat(200),
      description: "y".repeat(500),
      imageDataUrl: "https://tracker.example/image.png",
      faviconDataUrl: "data:image/svg+xml;base64,AAAA",
    });
    expect(await load()).toMatchObject({
      title: "x".repeat(180),
      description: "y".repeat(400),
      imageDataUrl: undefined,
      faviconDataUrl: undefined,
    });
  });

  it("keeps settled metadata through disconnect and reconnect but retires a changed identity", async () => {
    const { load, request, state } = fixture();
    const preview = await load();
    Object.assign(state, { connected: false, connectionGeneration: 2 });
    expect(await load()).toBe(preview);
    expect(request).toHaveBeenCalledOnce();
    Object.assign(state, { connected: true, connectionGeneration: 3 });
    expect(await load()).toMatchObject(preview);
    expect(request).toHaveBeenCalledTimes(2);
    state.recoveryScope = "another-account";
    request.mockResolvedValueOnce({ title: "New account" });
    expect(await load()).toMatchObject({ title: "New account" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("backs off empty metadata but retries transport failures", async () => {
    vi.useFakeTimers();
    const { load, request } = fixture();
    request.mockResolvedValueOnce({});
    expect(await load()).toEqual({});
    expect(await load()).toEqual({});
    expect(request).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_001);
    request.mockRejectedValueOnce(new Error("disconnected"));
    expect(await load()).toEqual({});
    expect(await load()).toMatchObject(fieldGuide);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
