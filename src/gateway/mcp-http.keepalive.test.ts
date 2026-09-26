import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: () => ({
    agentId: "main",
    tools: [
      {
        name: "wait_probe",
        label: "Wait probe",
        description: "Synthetic long-running tool",
        parameters: { type: "object", properties: {} },
        execute,
      },
    ],
  }),
}));

import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

beforeEach(() => {
  execute.mockReset();
  // Keep real network I/O and deadlines; only advance the heartbeat intervals.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  await closeMcpLoopbackServer();
  vi.useRealTimers();
});

async function startClient() {
  await ensureMcpLoopbackServer(0);
  const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "MCP runtime");
  return (method: "GET" | "POST", message?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method,
      headers: {
        authorization: `Bearer ${runtime.ownerToken}`,
        "content-type": "application/json",
      },
      ...(message ? { body: JSON.stringify(message) } : {}),
    });
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP idle timeout")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const toolCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "wait_probe", arguments: {} },
};

describe("MCP HTTP keepalive", () => {
  it.each(["success", "tool-error", "serialization-error"])(
    "keeps a pending JSON response alive and delivers one final result: %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      execute.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === "tool-error") {
          throw new Error("synthetic tool failure");
        }
        return {
          content: [
            {
              type: "text",
              text: "completed once",
              ...(outcome === "serialization-error" ? { _meta: { invalid: 1n } } : {}),
            },
          ],
        };
      });
      const send = await startClient();
      const responsePromise = send("POST", toolCall);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await within(entered.promise);
        await vi.advanceTimersByTimeAsync(30_000);
        const response = await within(responsePromise);
        expect(response.headers.get("content-type")).toBe("application/json");
        reader = expectDefined(response.body, "response body").getReader();
        const decoder = new TextDecoder();
        let body = decoder.decode((await within(reader.read())).value);
        expect(body.trim()).toBe("");
        await vi.advanceTimersByTimeAsync(30_000);
        body += decoder.decode((await within(reader.read())).value);
        expect(body.trim()).toBe("");
        release.resolve();
        for (;;) {
          const chunk = await within(reader.read());
          if (chunk.done) {
            break;
          }
          body += decoder.decode(chunk.value);
        }
        expect(JSON.parse(body)).toEqual(
          outcome === "serialization-error"
            ? {
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32603, message: "Internal error" },
              }
            : {
                jsonrpc: "2.0",
                id: 1,
                result: {
                  content: [
                    {
                      type: "text",
                      text: outcome === "tool-error" ? "synthetic tool failure" : "completed once",
                    },
                  ],
                  isError: outcome === "tool-error",
                },
              },
        );
        expect(execute).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release.resolve();
        if (reader) {
          await reader.cancel();
        } else {
          await (await responsePromise).body?.cancel();
        }
      }
    },
  );

  it("keeps a GET notification stream alive and releases it during shutdown", async () => {
    const send = await startClient();
    const response = await send("GET");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = expectDefined(response.body, "notification stream").getReader();
    try {
      const decoder = new TextDecoder();
      expect(decoder.decode((await within(reader.read())).value)).toBe(":\n\n");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(decoder.decode((await within(reader.read())).value)).toMatch(/^(?::\n\n)+$/);
      await within(closeMcpLoopbackServer());
      expect((await within(reader.read())).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });

  it("leaves long notifications empty with status 202", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    execute.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "completed" }] };
    });
    const send = await startClient();
    const { id: _id, ...notification } = toolCall;
    const pending = send("POST", notification);
    try {
      await within(entered.promise);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      release.resolve();
    }
    const response = await within(pending);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
