/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";

describe("chat message access", () => {
  it.each([
    ["agent:alpha:main", undefined],
    ["global", "alpha"],
  ])(
    "loads full messages for %s with only necessary agent routing",
    async (sessionKey, agentId) => {
      const request = vi.fn().mockResolvedValue({ ok: true, message: { role: "assistant" } });
      const { pane, state } = createRefreshChatPane(createGatewayBrowserClientFixture({ request }));
      Object.assign(state, {
        assistantAgentId: "alpha",
        agentsList: null,
        hello: null,
        sessionKey,
      });
      pane.render();

      expect(pane.chatProps?.fullMessageAgentId).toBe(agentId);
      expect(pane.chatProps?.loadFullAssistantMessage).toBeTypeOf("function");
      await pane.chatProps?.loadFullAssistantMessage?.({
        sessionKey,
        agentId: pane.chatProps.fullMessageAgentId,
        messageId: "message-1",
      });
      expect(request).toHaveBeenCalledWith("chat.message.get", {
        sessionKey,
        ...(agentId ? { agentId } : {}),
        messageId: "message-1",
        maxChars: 500_000,
      });
    },
  );

  it("disables full-message loading for catalog sessions", () => {
    const { pane, state } = createRefreshChatPane(createGatewayBrowserClientFixture());
    state.sessionKey = "catalog:catalog-1:host-1:thread-1";
    pane.render();

    expect(pane.chatProps?.loadFullAssistantMessage).toBeNull();
  });
});
