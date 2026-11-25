/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";
import { keepVolatileQueuedMessage } from "./chat-queue.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

it("publishes queue transitions without a redraw callback and preserves synchronous reads", () => {
  const host = createTestPageState(makeChatHost({ requestHandlers: {} }));
  const owner = chatOutboxOwner(host);
  onTestFinished(owner.subscribe(host));
  const read = vi.fn(() =>
    host.chatQueue.map((item) => `${item.text}: ${item.sendState}`).join(";"),
  );
  const view = mountSolid(() => <output>{read()}</output>);
  onTestFinished(view.unmount);
  const initialReads = read.mock.calls.length;

  owner.syncHost(host);
  flush();
  expect(read).toHaveBeenCalledTimes(initialReads);

  keepVolatileQueuedMessage(host, host.sessionKey, {
    id: "queued-input",
    text: "Keep this input",
    createdAt: 1,
    sendState: "held",
  });
  const held = host.chatQueue[0];
  expect(held?.sendState).toBe("held");
  flush();
  expect(view.container.textContent).toBe("Keep this input: held");
  expect(host.chatQueue[0]).toBe(held);

  owner.change(host, "queued-input", (item) => ({ ...item, sendState: "failed" }));
  expect(host.chatQueue[0]?.sendState).toBe("failed");
  flush();
  expect(view.container.textContent).toBe("Keep this input: failed");

  owner.remove(host, "queued-input");
  expect(host.chatQueue).toEqual([]);
  flush();
  expect(view.container.textContent).toBe("");

  keepVolatileQueuedMessage(host, host.sessionKey, {
    id: "previous-gateway-input",
    text: "Previous Gateway input",
    createdAt: 2,
    sendState: "held",
  });
  flush();
  expect(view.container.textContent).toBe("Previous Gateway input: held");
  host.settings.gatewayUrl = "https://replacement.example";
  chatOutboxOwner(host).syncHost(host);
  expect(host.chatQueue).toEqual([]);
  flush();
  expect(view.container.textContent).toBe("");
});
