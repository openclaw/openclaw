import { describe, expect, it } from "vitest";
import { agentCommand, installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "test" });

const OPENAI_SERVER_OPTIONS = {
  host: "127.0.0.1",
  auth: { mode: "token" as const, token: "secret" },
  controlUiEnabled: false,
  openAiChatCompletionsEnabled: true,
};

async function runOpenAiMessageChannelRequest(params?: { messageChannelHeader?: string }) {
  agentCommand.mockReset();
  agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

  let firstCall: { messageChannel?: string } | undefined;
  await withGatewayServer(
    async ({ port }) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: "Bearer secret",
      };
      if (params?.messageChannelHeader) {
        headers["x-openclaw-message-channel"] = params.messageChannelHeader;
      }
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      expect(res.status).toBe(200);
      firstCall = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { messageChannel?: string }
        | undefined;
      await res.text();
    },
    { serverOptions: OPENAI_SERVER_OPTIONS },
  );
  return firstCall;
}

describe("OpenAI HTTP message channel", () => {
  it("passes x-openclaw-message-channel through to agentCommand", async () => {
    const firstCall = await runOpenAiMessageChannelRequest({
      messageChannelHeader: "custom-client-channel",
    });
    expect(firstCall?.messageChannel).toBe("custom-client-channel");
  });

  it("defaults messageChannel to webchat when header is absent", async () => {
    const firstCall = await runOpenAiMessageChannelRequest();
    expect(firstCall?.messageChannel).toBe("webchat");
  });
});
