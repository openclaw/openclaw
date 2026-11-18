import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import {
  cacheChatSessionSnapshot,
  createChatWidgetLayout,
  type ChatMessageCache,
} from "../pages/chat/session-message-cache.ts";
import {
  loaded,
  client,
  mount,
  message,
  proxyReady,
  settle,
  alert,
  setupCanvasWidgetTests,
} from "./canvas-widget-view.test-support.ts";
import type { OpenClawCanvasWidgetView } from "./canvas-widget-view.tsx";
setupCanvasWidgetTests();

function reserveRow(view: OpenClawCanvasWidgetView) {
  const cache: ChatMessageCache = new Map();
  const host = { assistantAgentId: "main" };
  const target = { sessionKey: view.sessionKey };
  const row = 'row:v1:768:gutter:revision-1:"widget-row"';
  const key = `canvas:${view.docId}`;
  cacheChatSessionSnapshot(cache, host, target, {
    messages: [],
    pagination: { hasMore: false },
    sessionId: "session-1",
    widgetHeights: { [row]: 700, [key]: 600 },
  });
  const layout = createChatWidgetLayout()(cache, host, target);
  view.onHeightChange = (height, settled) => layout.write(key, height, "widget-row", settled);
  return { layout, row, key };
}

describe("Canvas widget layout settlement", () => {
  it("reserves early iframe sizes until a real report after document rendering", async () => {
    const { view, frame } = await loaded();
    const { layout, row } = reserveRow(view);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    proxyReady(frame);
    await settle(view);
    const renderId = post.mock.calls.find(
      ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
    )![0].params.renderId;
    message(frame, { type: "openclaw:widget-size", height: 200 });
    await settle(view);
    expect(frame.style.height).toBe("600px");
    expect(layout.read(row)).toBe(700);
    message(frame, { method: "ui/notifications/sandbox-resource-loaded", params: { renderId } });
    await settle(view);
    expect(frame.style.height).toBe("600px");
    expect(layout.read(row)).toBe(700);
    message(frame, { type: "openclaw:widget-size", height: 200 });
    await settle(view);
    expect(frame.style.height).toBe("200px");
    expect(layout.read(row)).toBeUndefined();
  });

  it("retires local padded geometry when a pending widget reports a runtime error", async () => {
    const { view, frame } = await loaded();
    const { layout, row, key } = reserveRow(view);
    proxyReady(frame);
    await settle(view);
    message(frame, { type: "openclaw:widget-size", height: 200 });
    await settle(view);
    expect(frame.style.height).toBe("600px");
    message(frame, { type: "openclaw:widget-runtime-error", message: "Synthetic widget failure" });
    await settle(view);
    expect(frame.style.height).toBe("200px");
    expect(layout.read(row)).toBeUndefined();
    expect(layout.read(key)).toBeUndefined();
  });

  it.each(["FORBIDDEN", "NOT_FOUND"])(
    "retires row and frame reservations for a terminal %s",
    async (code) => {
      const response = createDeferred<CanvasDocumentViewResult>();
      client.request.mockReturnValueOnce(response.promise);
      const view = mount();
      const { layout, row, key } = reserveRow(view);
      response.reject(new GatewayProtocolRequestError({ code, message: "Widget unavailable" }));
      await settle(view);
      expect(alert(view)?.textContent).toContain("Widget unavailable");
      expect(layout.read(row)).toBeUndefined();
      expect(layout.read(key)).toBeUndefined();
    },
  );
});
