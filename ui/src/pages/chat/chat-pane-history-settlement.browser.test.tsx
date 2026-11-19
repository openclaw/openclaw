import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import "../../styles/chat.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-application-context.test-support.ts";
import {
  connectPaneTestView,
  createTestChatPane,
  createRenderTestChatPane,
  type TestChatPane,
  nativeHistoryMessage,
} from "./chat-pane.test-support.ts";
import { render, renderChatThread } from "./test-helpers/chat-transcript-native.tsx";

it("fills an initially short transcript when its first geometry settles without an unrelated pane update", async () => {
  const historyRequest = vi.fn(async () => ({
    messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
    hasMore: false,
    totalMessages: 4,
  }));
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({
      request: (method) => (method === "chat.history" ? historyRequest() : Promise.resolve({})),
    }),
  });
  pane.paneId = "history-initial-geometry";
  pane.presentationId = pane.paneId;
  pane.sessionKey = state.sessionKey;
  state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
  state.chatHistoryPagination = {
    hasMore: true,
    olderCursor: "older-settlement",
    nextOffset: 2,
    totalMessages: 4,
  };
  state.chatLoading = false;
  pane.style.cssText = "display: none; width: 800px; height: 600px";
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = `
    openclaw-chat-runtime-test .chat-thread-viewport {
      height: 600px; width: 800px; flex: none;
    }
  `;
  onTestFinished(() => {
    pane.element.remove();
    style.remove();
  });
  connectPaneTestView(pane);
  document.body.append(pane.element);
  await pane.updateComplete;
  await vi.dynamicImportSettled();
  const root = expectDefined(pane.transcript.scrollElement, "mounted transcript scrollport");
  expect(root.querySelector(".chat-history-sentinel")).not.toBeNull();
  expect(pane.transcript.isPositionSettled).toBe(false);
  expect(historyRequest).not.toHaveBeenCalled();

  pane.style.display = "block";
  await expect.poll(() => pane.transcript.isPositionSettled).toBe(true);
  expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight);
  await expect.poll(() => historyRequest.mock.calls.length).toBe(1);
  expect(state.chatMessages).toEqual([
    nativeHistoryMessage(1),
    nativeHistoryMessage(2),
    nativeHistoryMessage(3),
    nativeHistoryMessage(4),
  ]);
  expect(state.chatFollowLocked).toBe(false);
  expect(state.chatReadingHistory).toBe(false);
});

it("loads older history when upward input interrupts a pending restoration", async () => {
  const older = Array.from({ length: 160 }, (_, index) => nativeHistoryMessage(index + 1));
  const historyRequest = vi.fn(async (_params: unknown, _options: unknown) => ({
    messages: older,
    hasMore: false,
    totalMessages: 190,
  }));
  const context = createInitializationContext();
  context.config.subscribe = () => () => {};
  const pane = createRenderTestChatPane();
  pane.paneId = "history-restoration-input";
  pane.presentationId = pane.paneId;
  pane.sessionKey = "agent:main:history-restoration-input";
  pane.initialize(context);
  document.body.append(pane.element);
  await pane.updateComplete;
  // SAFETY: The test host forwards protected state; startup replaces initialize()'s state.
  const state = (pane as unknown as TestChatPane).state;
  state.sessionKey = pane.sessionKey;
  state.client = createGatewayBrowserClientFixture({
    request: (method, params, options) =>
      method === "chat.history" ? historyRequest(params, options) : Promise.resolve({}),
  });
  state.connected = true;
  state.chatMessages = Array.from({ length: 30 }, (_, index) => nativeHistoryMessage(index + 161));
  state.chatHistoryPagination = {
    hasMore: true,
    olderCursor: "older-restoration",
    nextOffset: 30,
    totalMessages: 190,
  };
  state.chatLoading = false;
  pane.render();
  const props = expectDefined(pane.chatProps, "rendered pane callbacks");
  const host = document.body.appendChild(document.createElement("div"));
  host.className = "history-restoration-fixture";
  host.style.cssText = "width: 800px; height: 600px";
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = `
    .history-restoration-fixture .chat-thread-viewport {
      height: 600px; width: 800px; flex: none;
    }
  `;
  onTestFinished(() => {
    render(null, host);
    host.remove();
    pane.element.remove();
    style.remove();
  });
  render(renderChatThread(props, props.transcript), host);
  await vi.dynamicImportSettled();
  await expect.poll(() => pane.transcript.isPositionSettled).toBe(true);
  const root = expectDefined(pane.transcript.scrollElement, "mounted transcript scrollport");
  expect(root.scrollHeight).toBeGreaterThan(root.clientHeight);
  expect(historyRequest).not.toHaveBeenCalled();

  // Deliver reader input before the pending restore's next native layout frame.
  pane.transcript.scrollToOffset(0);
  expect(pane.transcript.isPositionSettled).toBe(false);
  root.scrollTop = 0;
  root.dispatchEvent(new Event("scroll"));
  root.dispatchEvent(new WheelEvent("wheel", { deltaY: -2000, bubbles: true }));
  expect(pane.transcript.isPositionSettled).toBe(true);
  expect(pane.transcript.isProgrammaticScroll).toBe(false);
  await expect.poll(() => historyRequest.mock.calls.length).toBe(1);
  expect(historyRequest).toHaveBeenCalledExactlyOnceWith(
    {
      sessionKey: state.sessionKey,
      limit: 1000,
      maxBytes: 3 * 1024 * 1024,
      toolResultMaxChars: 2_000,
      cursor: "older-restoration",
    },
    { signal: expect.any(AbortSignal) },
  );
  await expect.poll(() => state.chatMessages.length).toBe(190);
  expect(state.chatFollowLocked).toBe(true);
  expect(state.chatReadingHistory).toBe(true);
  // This renderer fixture commits the pane's next props explicitly.
  pane.render();
  const nextProps = expectDefined(pane.chatProps, "updated pane callbacks");
  render(renderChatThread(nextProps, nextProps.transcript), host);
  // Read back the loaded prefix; the interrupted gesture need not jump to its first row.
  pane.transcript.scrollToOffset(0);
  await expect.element(page.getByText("message 1", { exact: true })).toBeVisible();
});
