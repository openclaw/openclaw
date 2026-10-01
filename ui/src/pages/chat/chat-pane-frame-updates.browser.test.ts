import { expectDefined } from "@openclaw/normalization-core";
import { VirtualizerController } from "@tanstack/lit-virtual";
import { html } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { ChatSessionVirtualizerHost } from "./components/chat-transcript-virtualizer-host.ts";

// MessageChannel supplies distinct browser tasks without a timer or a real-frame race.
async function task(action: () => void) {
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve, reject) => {
      channel.port1.addEventListener(
        "message",
        () => {
          try {
            action();
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        { once: true },
      );
      channel.port1.start();
      channel.port2.postMessage(null);
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

function frameClock() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  return () => {
    const frame = [...callbacks.values()];
    callbacks.clear();
    for (const callback of frame) {
      callback(16);
    }
  };
}

async function mountPane() {
  const { pane } = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
  // Use the existing lifecycle harness, with a small render to isolate cadence.
  Object.assign(pane, { render: () => html`<span>${pane.presentationTitle}</span>` });
  const updates = vi.spyOn(pane, "performUpdate");
  ChatPaneBase.prototype.connectedCallback.call(pane);
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  updates.mockClear();
  return { pane, updates };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("coalesces six separate tasks and includes their property changes in updateComplete", async () => {
  const frame = frameClock();
  const { pane, updates } = await mountPane();
  for (let index = 0; index < 6; index++) {
    await task(() => {
      pane.presentationTitle = `revision ${index}`;
      pane.requestUpdate();
    });
  }
  console.info(`Six tasks before next frame: ${updates.mock.calls.length} updates`);
  expect(updates).not.toHaveBeenCalled();
  let completed = false;
  const completion = pane.updateComplete.then(() => {
    completed = true;
  });
  await task(() => {});
  expect(completed).toBe(false);
  frame();
  await completion;
  expect(updates).toHaveBeenCalledTimes(1);
  expect(pane.textContent).toContain("revision 5");
});

it.each(["scroll", "measurement"] as const)(
  "commits a virtualizer %s while a pane update waits for a frame",
  async (change) => {
    const frame = frameClock();
    const { pane, updates } = await mountPane();
    const getVirtualizer = vi.spyOn(VirtualizerController.prototype, "getVirtualizer");
    const session = new ChatSessionVirtualizerHost(pane, 0, undefined, {
      requestImmediateUpdate: () => ChatPaneBase.prototype.requestImmediateUpdate.call(pane),
    });
    const virtualizer = expectDefined(getVirtualizer.mock.results[0]?.value, "session virtualizer");
    // Exercise TanStack's measurement notification with explicit geometry, without
    // ResizeObserver delivery or a mounted row's platform-dependent layout.
    virtualizer.setOptions({
      ...virtualizer.options,
      count: 100,
      getItemKey: (index: number) => `row-${index}`,
      initialRect: { width: 600, height: 200 },
    });
    Object.assign(pane, {
      render: () =>
        html`<output>${virtualizer.getTotalSize()}</output><span>${pane.presentationTitle}</span>`,
    });
    try {
      pane.requestUpdate();
      frame();
      await pane.updateComplete;
      expect(pane.querySelector("output")?.textContent).toBe("12000");
      updates.mockClear();
      pane.presentationTitle = "committed notification";
      let completed = false;
      const completion = pane.updateComplete.then(() => {
        completed = true;
      });
      await task(() => {});
      expect(updates).not.toHaveBeenCalled();
      expect(completed).toBe(false);
      const notification = vi.spyOn(virtualizer.options, "onChange");
      if (change === "measurement") {
        virtualizer.resizeItem(0, 180);
      } else {
        virtualizer.options.onChange?.(virtualizer, true);
      }
      await task(() => {});
      expect(notification).toHaveBeenCalledExactlyOnceWith(virtualizer, change === "scroll");
      expect(updates).toHaveBeenCalledTimes(1);
      expect(completed).toBe(true);
      await completion;
      expect(pane.querySelector("output")?.textContent).toBe(
        change === "measurement" ? "12060" : "12000",
      );
      expect(pane.querySelector("span")?.textContent).toBe("committed notification");
    } finally {
      session.dispose();
    }
  },
);

it("releases a frame wait when hidden and resumes through the existing visibility gate", async () => {
  frameClock();
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const { pane, updates } = await mountPane();
  pane.requestUpdate();
  await task(() => {});
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await task(() => {});
  expect(updates).not.toHaveBeenCalled();
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
});

it("releases a disconnected pane's frame wait and does not delay its reconnect", async () => {
  frameClock();
  const { pane, updates } = await mountPane();
  pane.requestUpdate();
  await task(() => {});
  Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
  ChatPaneBase.prototype.disconnectedCallback.call(pane);
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  ChatPaneBase.prototype.connectedCallback.call(pane);
  pane.requestUpdate();
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(2);
});

it("keeps microtask updates when animation frames are unavailable", async () => {
  vi.stubGlobal("requestAnimationFrame", undefined);
  const { pane, updates } = await mountPane();
  await task(() => {
    pane.presentationTitle = "without frames";
  });
  await pane.updateComplete;
  expect(updates).toHaveBeenCalledTimes(1);
  expect(pane.textContent).toContain("without frames");
});
