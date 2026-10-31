// Session-key echo coverage for the OpenAI-compatible chat completions endpoint.
import { describe, expect, it } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function chatRequest(overrides: Record<string, unknown> = {}) {
  return { model: "openclaw", messages: [{ role: "user", content: "hi" }], ...overrides };
}

async function postChatCompletions(port: number, body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OpenAI-compatible HTTP session key echo (e2e)", () => {
  it("echoes the resolved session key and omits it before session resolution", async () => {
    const mockAgentOnce = () => {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
    };
    const firstAgentCommandSessionKey = () => {
      const options = agentCommandMock.mock.calls.at(0)?.[0] as { sessionKey?: string } | undefined;
      return options?.sessionKey;
    };
    const expectEchoedSessionKey = (res: Response, matcher: RegExp) => {
      const echoed = res.headers.get("x-openclaw-session-key");
      expect(echoed).toMatch(matcher);
      expect(echoed).toBe(firstAgentCommandSessionKey());
    };

    try {
      testState.agentsConfig = { entries: { main: {} } };
      resetConfigRuntimeState();

      await withGatewayServer(
        async ({ port }) => {
          {
            mockAgentOnce();
            const res = await postChatCompletions(port, chatRequest());
            expect(res.status).toBe(200);
            expectEchoedSessionKey(res, /^agent:main:openai:[0-9a-f-]{36}$/);
            await res.text();
          }

          {
            mockAgentOnce();
            const res = await postChatCompletions(port, chatRequest({ user: "alice" }));
            expect(res.status).toBe(200);
            expectEchoedSessionKey(res, /^agent:main:openai-user:alice$/);
            await res.text();
          }

          {
            mockAgentOnce();
            const res = await postChatCompletions(port, chatRequest({ user: "张三" }));
            expect(res.status).toBe(200);
            expect(res.headers.get("x-openclaw-session-key")).toBeNull();
            expect(firstAgentCommandSessionKey()).toBe("agent:main:openai-user:张三");
            await res.text();
          }

          {
            mockAgentOnce();
            const res = await postChatCompletions(port, chatRequest(), {
              "x-openclaw-session-key": "agent:main:openai:custom",
            });
            expect(res.status).toBe(200);
            expectEchoedSessionKey(res, /^agent:main:openai:custom$/);
            await res.text();
          }

          {
            mockAgentOnce();
            const res = await postChatCompletions(port, chatRequest({ stream: true }));
            expect(res.status).toBe(200);
            expectEchoedSessionKey(res, /^agent:main:openai:/);
            await res.text();
          }

          {
            agentCommandMock.mockClear();
            const res = await postChatCompletions(port, chatRequest(), {
              "x-openclaw-session-key": "agent:main:subagent:spoofed",
            });
            expect(res.status).toBe(400);
            expect(res.headers.get("x-openclaw-session-key")).toBeNull();
            await res.text();
          }

          {
            agentCommandMock.mockClear();
            const res = await postChatCompletions(port, chatRequest(), {
              "x-openclaw-agent-id": "missing-agent",
            });
            expect(res.status).toBe(400);
            expect(res.headers.get("x-openclaw-session-key")).toBeNull();
            await res.text();
          }
        },
        {
          serverOptions: {
            host: "127.0.0.1",
            auth: { mode: "none" },
            controlUiEnabled: false,
            openAiChatCompletionsEnabled: true,
          },
        },
      );
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });
});
