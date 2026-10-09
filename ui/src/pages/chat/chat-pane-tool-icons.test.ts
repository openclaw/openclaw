/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-tool-icons.test/"} */
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { ChatPane } from "./chat-pane-render.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import { ChatToolIconController } from "./chat-tool-icon-controller.ts";

afterEach(() => vi.restoreAllMocks());

it("loads tool ownership for accepted history absent from the capped session list", async () => {
  const controllers = vi.spyOn(ChatPane.prototype, "addController");
  const client = new GatewayBrowserClient({ url: "ws://chat-pane-tool-icons.test" });
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("optional metadata"));
  const { pane } = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
  const state = pane.state;
  state.connected = true;
  state.sessionKey = "agent:main:older-chat";
  state.currentSessionId = "older-session";
  state.sessionsResult = null;
  state.chatRunId = null;
  pane.context.gateway.snapshot.client = client;
  pane.context.gateway.snapshot.phase = "connected";
  setChatHistoryLoad(state, {
    phase: "committed",
    sessions: state.sessions,
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    requestAgentId: undefined,
    sessionInfo: {
      key: state.sessionKey,
      sessionId: state.currentSessionId,
      agentId: "main",
      kind: "direct",
    },
  });
  const controller = controllers.mock.calls
    .map(([value]) => value)
    .find((value) => value instanceof ChatToolIconController);
  expect(controller).toBeDefined();
  controller?.hostUpdate();
  controller?.icons.get("example_tool");
  await Promise.resolve();
  expect(request).toHaveBeenCalledWith(
    "tools.effective",
    { sessionKey: state.sessionKey, agentId: "main" },
    expect.anything(),
  );
  controller?.hostDisconnected();
});
