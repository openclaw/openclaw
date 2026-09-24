/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-navigation.test/"} */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { navigateChatPage } from "./chat-page-navigation.ts";
import { createChatPageNavigationContext } from "./chat-page.test-support.ts";

describe("chat page navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    { agentId: "main", face: "chat" },
    { agentId: "main", face: "dashboard" },
    { agentId: "research", face: "chat" },
    { agentId: "research", face: "dashboard" },
  ] as const)(
    "keeps $agentId $face navigation stable when its pane adopts global",
    async ({ agentId, face }) => {
      window.history.replaceState({}, "", `/${face}/${agentId}`);
      const navigation = createChatPageNavigationContext();
      navigation.context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main" }, { id: "research" }],
      };
      navigation.context.gateway.snapshot.hello = {
        ...gatewayHelloForMethods([]),
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: "global" },
        },
      };
      navigation.context.agentSelection.set(agentId);
      navigateChatPage(
        navigation.context,
        { sessionKey: `agent:${agentId}:main`, face },
        "global",
        true,
      );
      expect(navigation.replace).toHaveBeenCalledExactlyOnceWith(face, {
        pathname: `/${face}/${agentId}`,
      });
    },
  );
});
