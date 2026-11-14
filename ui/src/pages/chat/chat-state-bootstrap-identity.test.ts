import { expect, it } from "vitest";
import { normalizeAssistantIdentity } from "../../lib/assistant-identity.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { resolveChatAvatarUrl } from "./chat-state-route.ts";

it.each([
  ["main", "main", undefined, "Observatory", "/avatar/main"],
  ["main", "other", undefined, "", null],
  [null, "other", undefined, "Observatory", null],
  ["main", "main", "wss://other.example", "", null],
  [null, "other", "wss://other.example", "Observatory", null],
] as const)(
  "scopes bootstrap identity from %s to %s over %s",
  (owner, agentId, gatewayUrl, name, avatar) => {
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
        sessionKey: `agent:${agentId}:topic`,
        dispatchEvent: () => true,
      },
    );
    expect(state.assistantName).toBe(name);
    expect(resolveChatAvatarUrl(state)).toBe(avatar);
  },
);
