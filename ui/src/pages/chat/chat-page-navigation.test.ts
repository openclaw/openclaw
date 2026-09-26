/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-navigation.test/"} */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { navigateChatPage, ownedChatPaneSessionKey } from "./chat-page-navigation.ts";
import { createChatPageNavigationContext } from "./chat-page.test-support.ts";

describe("chat page navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    { scope: "global", key: "global", agentId: "research", expected: "agent:research:main" },
    { scope: "per-sender", key: "global", agentId: "research", expected: "global" },
    {
      scope: "global",
      key: "agent:research:global",
      agentId: "main",
      expected: "agent:research:global",
    },
    { scope: "global", key: "global", agentId: undefined, expected: "global" },
  ] as const)(
    "preserves the $scope meaning of $key with captured owner $agentId",
    ({ scope, key, agentId, expected }) => {
      const { context } = createChatPageNavigationContext();
      context.agents.state.agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope,
        agents: [{ id: "main" }, { id: "research" }],
      };
      expect(ownedChatPaneSessionKey(context, key, agentId)).toBe(expected);
    },
  );
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
