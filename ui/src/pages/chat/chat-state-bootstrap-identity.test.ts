import { expect, it } from "vitest";
import { normalizeAssistantIdentity } from "../../lib/assistant-identity.ts";
import { createChatPageStateContext } from "./chat-page.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { resolveChatAvatarUrl } from "./chat-state-route.ts";

it.each([
  { owner: "main", agentId: "main", name: "Observatory", avatar: "/avatar/main" },
  { owner: "main", agentId: "other", name: "", avatar: null },
  { owner: null, agentId: "other", name: "Observatory", avatar: null },
  { owner: "main", agentId: "main", gatewayUrl: "wss://other.example", name: "", avatar: null },
])(
  "scopes bootstrap identity from $owner to the $agentId chat",
  ({ owner, agentId, gatewayUrl, name, avatar }) => {
    const initial = createChatPageStateContext();
    const context = {
      ...initial,
      gateway: {
        ...initial.gateway,
        connection: {
          ...initial.gateway.connection,
          gatewayUrl: gatewayUrl ?? window.location.origin.replace(/^http/u, "ws"),
        },
      },
      agentSelection: {
        ...initial.agentSelection,
        state: { ...initial.agentSelection.state, selectedId: agentId },
      },
      config: {
        ...initial.config,
        current: {
          ...initial.config.current,
          assistantIdentity: normalizeAssistantIdentity({
            agentId: owner,
            name: "Observatory",
            avatar: "/avatar/main",
          }),
        },
      },
    };
    const state = createPageState(
      context,
      { invalidate: () => {}, afterCommit: () => () => {} },
      {
        sessionKey: `agent:${agentId}:topic`,
        dispatchEvent: () => true,
        getBoundingClientRect: () => new DOMRect(0, 0, 1440, 900),
        querySelector: () => null,
      },
    );
    expect(state.assistantName).toBe(name);
    expect(resolveChatAvatarUrl(state)).toBe(avatar);
  },
);
