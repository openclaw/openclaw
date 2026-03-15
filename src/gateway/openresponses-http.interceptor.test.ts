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
    openResponsesEnabled: true,
  });
});

afterAll(async () => {
  await server.close({ reason: "interceptor test suite done" });
});

afterEach(() => {
  agentCommand.mockClear();
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
  return await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const responsesBody = (opts?: { stream?: boolean }) => ({
  model: "openclaw",
  input: "hello",
  ...(opts?.stream !== undefined ? { stream: opts.stream } : {}),
});

function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const lines = text.split("\n");
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice("data: ".length));
    } else if (line.trim() === "" && currentData.length > 0) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = undefined;
      currentData = [];
    }
  }

  return events;
}

describe("OpenResponses HTTP dispatch interceptor (e2e)", () => {
  it("blocks non-streaming request when interceptor returns intercepted: true", async () => {
    injectInterceptors([
      {
        async intercept(_text, _ctx, output) {
          output.sendBlock("Blocked by test interceptor.");
          return { intercepted: true };
        },
      },
    ]);

    const res = await post(responsesBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("completed");

    const output = json.output as Array<Record<string, unknown>>;
    expect(output.length).toBe(1);
    expect(output[0].type).toBe("message");

    const content = (output[0].content as Array<Record<string, unknown>>)[0];
    expect(content.type).toBe("output_text");
    expect(content.text).toBe("Blocked by test interceptor.");

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

    const res = await post(responsesBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const text = await res.text();
    const events = parseSseEvents(text);

    // Should have the full OpenResponses SSE event sequence.
    const jsonEvents = events
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data) as Record<string, unknown>);
    const eventTypes = jsonEvents.map((e) => e.type);

    expect(eventTypes).toContain("response.created");
    expect(eventTypes).toContain("response.output_text.delta");
    expect(eventTypes).toContain("response.completed");

    // Extract the delta text.
    const deltaEvent = jsonEvents.find((e) => e.type === "response.output_text.delta");
    expect(deltaEvent?.delta).toBe("Stream blocked.");

    // Last data line should be [DONE].
    const lastLine = text.trim().split("\n").pop()?.trim();
    expect(lastLine).toBe("data: [DONE]");

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

    const res = await post(responsesBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("completed");

    const output = json.output as Array<Record<string, unknown>>;
    const content = (output[0].content as Array<Record<string, unknown>>)[0];
    expect(content.text).toBe("Agent reply");

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

    const res = await post(responsesBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    const output = json.output as Array<Record<string, unknown>>;
    const content = (output[0].content as Array<Record<string, unknown>>)[0];
    expect(content.text).toBe("Request intercepted.");

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

    const res = await post(responsesBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("completed");
    const output = json.output as Array<Record<string, unknown>>;
    const content = (output[0].content as Array<Record<string, unknown>>)[0];
    expect(content.text).toBe("Partial block.");

    expect(agentCommand).not.toHaveBeenCalled();
  });
});
