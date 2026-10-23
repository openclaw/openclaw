import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import "../../styles.css";
import "../../styles/chat.ts";
import {
  connectPaneTestView,
  createGatewayBrowserClientFixture,
  createTestChatPane,
  nativeHistoryMessage,
} from "./chat-pane.test-support.ts";

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
  state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
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
