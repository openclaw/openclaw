import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let enabledPort: number;
let enabledServer: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];

beforeAll(async () => {
  const started = await startGatewayServerWithRetries({
    port: await getGatewayTestPort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    },
  });
  enabledPort = started.port;
  enabledServer = started.server;
});

afterAll(async () => {
  await enabledServer?.close({ reason: "openai http session-key suite done" });
});

async function postChatCompletions(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OpenAI-compatible HTTP session binding", () => {
  it("does not reuse one session from a constant OpenAI user", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
      const res = await postChatCompletions({
        user: "raycast-extension",
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
      const opts = agentCommandMock.mock.calls.at(-1)?.[0] as { sessionKey?: string } | undefined;
      keys.push(opts?.sessionKey ?? "");
      await res.text();
    }
    expect(keys[0]).not.toContain("openai-user:raycast-extension");
    expect(keys[1]).not.toContain("openai-user:raycast-extension");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("binds Chat Completions from an explicit session key", async () => {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
    const res = await postChatCompletions(
      {
        user: "raycast:extension",
        model: "openclaw",
        messages: [{ role: "user", content: "hi" }],
      },
      { "x-openclaw-session-key": "customer-case-42" },
    );
    expect(res.status).toBe(200);
    const opts = agentCommandMock.mock.calls.at(0)?.[0] as { sessionKey?: string } | undefined;
    expect(opts?.sessionKey).toBe("customer-case-42");
    await res.text();
  });
});
