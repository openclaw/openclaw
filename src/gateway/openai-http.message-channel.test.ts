import { describe, expect, it } from "vitest";
import { agentCommand, installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "test" });

describe("OpenAI HTTP message channel", () => {
  it("passes x-openclaw-message-channel through to agentCommand", async () => {
    agentCommand.mockReset();
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);

    await withGatewayServer(
      async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer secret",
            "x-openclaw-message-channel": "custom-client-channel",
          },
          body: JSON.stringify({
            model: "openclaw",
            messages: [{ role: "user", content: "hi" }],
          }),
        });

        expect(res.status).toBe(200);
        const firstCall = (agentCommand.mock.calls[0] as unknown[] | undefined)?.[0] as
          | { messageChannel?: string }
          | undefined;
        expect(firstCall?.messageChannel).toBe("custom-client-channel");
        await res.text();
      },
      {
        serverOptions: {
          host: "127.0.0.1",
          auth: { mode: "token", token: "secret" },
          controlUiEnabled: false,
          openAiChatCompletionsEnabled: true,
        },
      },
    );
  });
});
