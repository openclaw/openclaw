// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  backendGatewayClient,
  buildExistingMainStoreEntry,
  cronMediaCompletionEvent,
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  mockMainSessionEntry,
  mockSuccessfulAgentCommand,
  waitForAgentCommandCall,
  type AgentHandlerArgs,
  type AgentParams,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it.each<{
    name: string;
    webchat: boolean;
    request: AgentParams;
    external: boolean;
  }>([
    { name: "WebChat connection", webchat: true, request: {}, external: false },
    {
      name: "WebChat last-route request",
      webchat: true,
      request: { channel: "last" },
      external: false,
    },
    {
      name: "captured WebChat origin",
      webchat: false,
      request: { channel: "webchat" },
      external: false,
    },
    {
      name: "explicit external reply",
      webchat: true,
      request: { replyChannel: "telegram" },
      external: true,
    },
    {
      name: "explicit external channel",
      webchat: true,
      request: { channel: "telegram", to: "12345" },
      external: true,
    },
    {
      name: "explicit external recipient",
      webchat: true,
      request: { to: "12345" },
      external: true,
    },
    { name: "unbound backend", webchat: false, request: {}, external: true },
  ])("keeps the $name completion on its owned route", async (testCase) => {
    const delivery = normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "12345", accountId: "bot-1", threadId: 42 },
    });
    mockMainSessionEntry({ sessionId: "existing-session-id", delivery });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ delivery }),
      };
      return await updater(store);
    });

    mockSuccessfulAgentCommand();

    await invokeAgent(
      {
        message: "show the completed image",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-webchat-origin-channel",
        deliver: true,
        internalEvents: [cronMediaCompletionEvent()],
        ...testCase.request,
      },
      {
        reqId: "webchat-origin-1",
        client: testCase.webchat
          ? ({
              connect: {
                client: { id: "webchat-ui", mode: "webchat" },
              },
            } as AgentHandlerArgs["client"])
          : backendGatewayClient(),
        isWebchatConnect: () => testCase.webchat,
      },
    );

    const callArgs = await waitForAgentCommandCall<{
      channel?: string;
      deliver?: boolean;
      to?: string;
      accountId?: string;
      threadId?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string; accountId?: string; currentThreadTs?: string };
    }>();
    expect(callArgs.channel).toBe(testCase.external ? "telegram" : "webchat");
    expect(callArgs.deliver).toBe(testCase.external);
    expect(callArgs.to).toBe(testCase.external ? "12345" : undefined);
    if (!testCase.external) {
      expect(callArgs.messageChannel).toBe("webchat");
      expect(callArgs.accountId).toBeUndefined();
      expect(callArgs.threadId).toBeUndefined();
      expect(callArgs.runContext).toMatchObject({
        messageChannel: "webchat",
        accountId: undefined,
        currentThreadTs: undefined,
      });
    }
  });
});
