import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { DispatchInterceptorPlugin } from "../plugins/types.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  resetTestPluginRegistry,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  port = await getFreePort();
  server = await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: true,
  });
});

afterAll(async () => {
  await server.close({ reason: "interceptor test suite done" });
});

afterEach(() => {
  agentCommand.mockClear();
  // Reset the global hook runner registry so interceptors don't leak between tests.
  resetTestPluginRegistry();
  initializeGlobalHookRunner({
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
    dispatchInterceptors: [],
  } as unknown as PluginRegistry);
});

function injectInterceptors(interceptors: DispatchInterceptorPlugin[]) {
  initializeGlobalHookRunner({
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
    dispatchInterceptors: interceptors,
  } as unknown as PluginRegistry);
}

async function post(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const chatBody = (opts?: { stream?: boolean }) => ({
  model: "openclaw",
  messages: [{ role: "user", content: "hello" }],
  ...(opts?.stream !== undefined ? { stream: opts.stream } : {}),
});

function parseSseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

describe("OpenAI HTTP dispatch interceptor (e2e)", () => {
  it("blocks non-streaming request when interceptor returns intercepted: true", async () => {
    injectInterceptors([
      {
        async intercept(_text, _ctx, output) {
          output.sendBlock("Blocked by test interceptor.");
          return { intercepted: true };
        },
      },
    ]);

    const res = await post(chatBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.object).toBe("chat.completion");
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe("Blocked by test interceptor.");

    // Agent should NOT have been called.
    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("blocks streaming request when interceptor returns intercepted: true", async () => {
    injectInterceptors([
      {
        async intercept(_text, _ctx, output) {
          output.sendBlock("Stream blocked.");
          return { intercepted: true };
        },
      },
    ]);

    const res = await post(chatBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const text = await res.text();
    const data = parseSseDataLines(text);
    expect(data[data.length - 1]).toBe("[DONE]");

    const jsonChunks = data
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
    expect(jsonChunks.length).toBe(2);
    expect(jsonChunks[0].object).toBe("chat.completion.chunk");

    // First chunk: role only (no content) per OpenAI spec
    const firstDelta = (jsonChunks[0].choices as Array<Record<string, unknown>>)[0].delta as Record<
      string,
      unknown
    >;
    expect(firstDelta.role).toBe("assistant");
    expect(firstDelta.content).toBeUndefined();

    // Second chunk: content only (no role)
    const secondDelta = (jsonChunks[1].choices as Array<Record<string, unknown>>)[0]
      .delta as Record<string, unknown>;
    expect(secondDelta.content).toBe("Stream blocked.");

    const content = jsonChunks
      .flatMap((c) => (c.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map((choice) => (choice.delta as Record<string, unknown> | undefined)?.content)
      .filter((v): v is string => typeof v === "string")
      .join("");
    expect(content).toBe("Stream blocked.");

    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("passes through when interceptor returns intercepted: false", async () => {
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "Agent reply" }] } as never);

    injectInterceptors([
      {
        async intercept() {
          return { intercepted: false };
        },
      },
    ]);

    const res = await post(chatBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe("Agent reply");

    expect(agentCommand).toHaveBeenCalledTimes(1);
  });

  it("uses default message when interceptor sends no content", async () => {
    injectInterceptors([
      {
        async intercept() {
          return { intercepted: true };
        },
      },
    ]);

    const res = await post(chatBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe("Request intercepted.");

    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("collects sendStreamChunk output into response", async () => {
    injectInterceptors([
      {
        async intercept(_text, _ctx, output) {
          output.sendStreamChunk("Part 1. ");
          output.sendStreamChunk("Part 2.");
          output.sendStreamDone();
          return { intercepted: true };
        },
      },
    ]);

    const res = await post(chatBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe("Part 1. Part 2.");

    expect(agentCommand).not.toHaveBeenCalled();
  });

  it("treats thrown interceptor after output as intercepted", async () => {
    agentCommand.mockResolvedValueOnce({ payloads: [{ text: "Agent reply" }] } as never);

    injectInterceptors([
      {
        async intercept(_text, _ctx, output) {
          output.sendBlock("Partial block.");
          throw new Error("interceptor failed after output");
        },
      },
    ]);

    const res = await post(chatBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe("Partial block.");

    expect(agentCommand).not.toHaveBeenCalled();
  });
});
