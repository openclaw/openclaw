import { describe, expect, it, vi } from "vitest";
import {
  flush,
  minted,
  PAGE_URL,
  ready,
  receive,
  streamFixture,
} from "./browser-panel-stream.test-support.ts";
import { screencastFrame, TestScreencastSocket } from "./browser-screencast-test-support.ts";

describe("Browser panel screencast transport", () => {
  const { setup, sockets, createdUrls } = streamFixture(TestScreencastSocket);

  it("resolves the gateway socket and decodes metadata and JPEG bytes", async () => {
    const { client, controller, calls } = setup(async (request) =>
      request.path === "/screencast"
        ? { ...minted, wsPath: "/browser/screencast?token=abc" }
        : undefined,
    );
    Object.assign(client, { gatewayUrl: "https://gateway.example.test/chat" });
    const pending = controller.refreshAll();
    await flush();
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://gateway.example.test/browser/screencast?token=abc");
    expect(socket.binaryType).toBe("arraybuffer");
    await receive(socket, ready);
    expect(controller.tabs[0]).toMatchObject({ url: PAGE_URL, title: "Page" });
    expect(controller.urlDraft).toBe(PAGE_URL);
    await receive(
      socket,
      JSON.stringify({ type: "meta", url: "https://example.test/next", title: "Next" }),
    );
    expect(controller.tabs[0]).toMatchObject({
      url: "https://example.test/next",
      title: "Next",
    });
    expect(controller.urlDraft).toBe("https://example.test/next");
    expect(controller.view).toBeNull();
    await receive(socket, screencastFrame(PAGE_URL));
    await pending;
    expect(controller.view).toMatchObject({
      targetId: "tab-a",
      dataUrl: "blob:frame-0",
      url: PAGE_URL,
      metrics: { cssWidth: 100, cssHeight: 100, url: PAGE_URL },
    });
    const blob = vi.mocked(URL).createObjectURL.mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) {
      throw new Error("Expected a decoded screencast Blob");
    }
    expect(blob.type).toBe("image/jpeg");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
    controller.suspendView();
    expect(socket.close).toHaveBeenCalledOnce();
    await receive(socket, screencastFrame());
    socket.disconnect(1000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.view).toBeNull();
    expect(createdUrls).toHaveLength(1);
    expect(calls("/screencast")).toHaveLength(1);
    expect(calls("/screenshot")).toHaveLength(0);
  });

  it.each([
    "{",
    new ArrayBuffer(2),
    new Uint8Array([0, 0, 1, 0, 0]).buffer,
    JSON.stringify({ type: "error", error: "Unavailable" }),
  ])("retires failed transport and recovers through the panel (%s)", async (wire) => {
    const { controller, calls } = setup();
    const pending = controller.refreshAll();
    await flush();
    const socket = sockets[0]!;
    await receive(socket, wire);
    await pending;
    expect(socket.close).toHaveBeenCalled();
    expect(createdUrls).toHaveLength(0);
    expect(controller.view?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(controller.loading).toBe(false);
    expect(calls("/screenshot")).toHaveLength(1);
    expect(calls("/screencast")).toHaveLength(1);
    const fallback = controller.view;
    await receive(socket, screencastFrame());
    socket.disconnect(1006);
    await flush();
    expect(controller.view).toBe(fallback);
    expect(createdUrls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls("/screencast")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls("/screencast")).toHaveLength(2);
    expect(calls("/screenshot")).toHaveLength(1);
  });
});
