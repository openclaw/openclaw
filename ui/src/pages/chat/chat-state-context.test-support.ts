import { vi } from "vitest";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createGatewayHarness } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createChatPageSessions } from "./chat-page-sessions.test-support.ts";

export function createChatPageStateContext() {
  const { gateway, publish } = createGatewayHarness(createTestGatewayClient(vi.fn()));
  publish(false, null);
  return {
    agents: {
      state: { agentsList: null },
      ensureList: vi.fn(async () => null),
    },
    agentSelection: { state: { selectedId: "main" } },
    agentIdentity: createAgentIdentityCapability(gateway),
    basePath: "",
    config: {
      current: {
        allowExternalEmbedUrls: false,
        assistantIdentity: { name: "Assistant" },
        embedSandboxMode: "scripts",
      },
    },
    gateway: { ...gateway, connection: { gatewayUrl: "ws://gateway.example.test" } },
    chatSubmissions: createChatSubmissions(),
    sessions: createChatPageSessions(gateway),
  } as unknown as ApplicationContext;
}
