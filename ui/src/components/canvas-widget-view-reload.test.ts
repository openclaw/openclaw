import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  client,
  documentView,
  loaded,
  message,
  proxyReady,
  settle,
  setupCanvasWidgetTests,
} from "./canvas-widget-view.test-support.ts";

setupCanvasWidgetTests();

describe("Canvas widget sandbox reload", () => {
  it("replays the canvas document when the same isolated frame boots again", async () => {
    const { view, frame } = await loaded();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const deliveries = () =>
      post.mock.calls
        .map(([data]) => data)
        .filter((data) => data.method === "ui/notifications/sandbox-resource-ready");

    proxyReady(frame);
    await settle(view);
    expect(deliveries()).toHaveLength(1);
    const first = deliveries()[0].params;
    message(frame, {
      method: "ui/notifications/sandbox-resource-loaded",
      params: { renderId: first.renderId },
    });

    proxyReady(frame);
    await settle(view);
    expect(deliveries()).toHaveLength(2);
    expect(deliveries()[1].params.html).toBe(documentView.html);
    expect(deliveries()[1].params.renderId).not.toBe(first.renderId);
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("retires inline inspection on reload and waits for the replacement port to be ready", async () => {
    const { view, frame } = await loaded();
    proxyReady(frame);
    await settle(view);
    const offer = () => {
      const channel = new MessageChannel();
      onTestFinished(() => {
        channel.port1.close();
        channel.port2.close();
      });
      message(frame, { type: "openclaw:widget-prompt-offer" }, [channel.port1]);
      return channel;
    };
    const first = offer();
    const close = vi.spyOn(first.port1, "close");
    const receive = vi.fn();
    first.port2.postMessage({ type: "openclaw:widget-inspect-ready" });
    await expect.poll(() => view.startInspection(receive)).toBeTypeOf("function");
    message(frame, {
      method: "ui/notifications/sandbox-proxy-ready",
      params: { sandboxUrl: "wrong" },
    });
    expect(close).not.toHaveBeenCalled();
    proxyReady(frame);
    await settle(view);
    expect(close).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledExactlyOnceWith({ kind: "cancel" });
    const next = offer();
    expect(view.startInspection(receive)).toBeUndefined();
    next.port2.postMessage({ type: "openclaw:widget-inspect-ready" });
    await expect.poll(() => view.startInspection(receive)).toBeTypeOf("function");
  });
});
