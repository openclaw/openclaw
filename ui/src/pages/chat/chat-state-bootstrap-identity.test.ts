import { expect, it } from "vitest";
import { normalizeAssistantIdentity } from "../../lib/assistant-identity.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { resolveChatAvatarUrl } from "./chat-state-route.ts";

it.each([
  ["main", "main", undefined, "Observatory", "/avatar/main", undefined, "main"],
  ["main", "other", undefined, "", null, undefined, "main"],
  [null, "other", undefined, "Observatory", null, undefined, "main"],
  ["main", "main", "wss://other.example", "", null, undefined, "main"],
  [null, "other", "wss://other.example", "Observatory", null, undefined, "main"],
  ["research", "global", undefined, "Observatory", "/avatar/main", "research", "research"],
  ["main", "global", undefined, "Observatory", "/avatar/main", "", "main"],
  ["main", "global", undefined, "Observatory", "/avatar/main", undefined, "main"],
] as const)(
  "scopes bootstrap identity from %s to %s over %s",
  (owner, agentId, gatewayUrl, name, avatar, paneAgentId, expectedAgentId) => {
    const context = createChatPageStateContext();
    Object.assign(context.gateway.connection, {
      gatewayUrl: gatewayUrl ?? window.location.origin.replace(/^http/u, "ws"),
    });
    context.config.current.assistantIdentity = normalizeAssistantIdentity({
      agentId: owner,
      name: "Observatory",
      avatar: "/avatar/main",
    });
    const state = createPageState(
      context,
      { afterCommit: () => () => {} },
      {
        sessionKey: agentId === "global" ? "global" : `agent:${agentId}:topic`,
        agentId: paneAgentId,
        dispatchEvent: () => true,
      },
    );
    expect(state.assistantAgentId).toBe(expectedAgentId);
    expect(state.agentsSelectedId).toBe(expectedAgentId);
    expect(state.assistantName).toBe(name);
    expect(resolveChatAvatarUrl(state)).toBe(avatar);
  },
);
