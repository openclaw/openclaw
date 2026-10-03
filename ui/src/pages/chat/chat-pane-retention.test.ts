/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-retained.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createGatewayBrowserClientFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";

describe("chat pane retained presentation lifecycle", () => {
  afterEach(() => {
    resetChatComposerState();
    vi.unstubAllGlobals();
  });

  it.each(["connection", "pane"] as const)(
    "releases reply preview objects at the %s retirement boundary",
    async (boundary) => {
      class ReplyPreviewMessage {
        role = "assistant";
        content = "Previous connection's answer";
      }
      let preview: WeakRef<ReplyPreviewMessage> | undefined;
      let requests = 0;
      const client = createGatewayBrowserClientFixture({
        request: async (method) => {
          if (method !== "chat.message.get") {
            return {};
          }
          requests += 1;
          const message = new ReplyPreviewMessage();
          preview = new WeakRef(message);
          return { ok: true, message };
        },
      });
      const { pane } = createTestChatPane({ client });
      pane.requestReplyMessage("source-message");
      await vi.waitFor(() => expect(pane.readReplyMessage("source-message")).toBeDefined());

      pane.resetOlderMessagesViewport();
      pane.presented = false;
      pane.presented = true;
      const retainedControl = new WeakRef({ unowned: true });
      await collectGarbageForTest();
      expect(retainedControl.deref()).toBeUndefined();
      expect(preview!.deref()).toBeDefined();
      pane.requestReplyMessage("source-message");
      expect(requests).toBe(1);

      if (boundary === "connection") {
        pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "stopped" });
      } else {
        pane.disconnectedCallback();
      }
      const retiredControl = new WeakRef({ unowned: true });
      await collectGarbageForTest();
      expect(retiredControl.deref()).toBeUndefined();
      expect(preview!.deref()).toBeUndefined();
      expect(pane.readReplyMessage("source-message")).toBeUndefined();
    },
  );
});
