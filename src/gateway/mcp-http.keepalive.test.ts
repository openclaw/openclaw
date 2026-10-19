import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  resolveGatewayScopedTools: () => mcp.probeTools("wait_probe", execute),
}));

import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import * as mcp from "./mcp-http.test-request.js";

beforeEach(() => {
  execute.mockReset();
  // Keep real network I/O and deadlines; only advance the heartbeat intervals.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  try {
    await closeMcpLoopbackServer();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

async function startClient() {
  await ensureMcpLoopbackServer(0);
  const runtime = mcp.runtime();
  return (method: "GET" | "POST", message?: unknown) => mcp.request(runtime, message, { method });
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

const toolCall = mcp.toolCall("wait_probe");
const completed = { content: [{ type: "text", text: "completed once" }] };
const decoder = new TextDecoder();
const readText = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  decoder.decode((await within(reader.read())).value);

async function drain(read: () => ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>) {
  let body = "";
  for (;;) {
    const chunk = await read();
    if (chunk.done) {
      return body;
    }
    body += decoder.decode(chunk.value);
  }
}

it("disables connection reuse for consecutive completed tool calls", async () => {
  execute.mockResolvedValue(completed);
  const send = await startClient();
  for (let id = 1; id <= 2; id++) {
    const response = await send("POST", { ...toolCall, id });
    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toMatchObject({
      id,
      result: { ...completed, isError: false },
    });
  }
  expect(execute).toHaveBeenCalledTimes(2);
});

it.each(["success", "serialization-error", "notification"])(
  "keeps pending calls alive without writing notification bodies: %s",
  async (outcome) => {
    const entered = createDeferred();
    const release = createDeferred();
    execute.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
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
    const serverTimers = vi.getTimerCount();
    const { id: _id, ...notification } = toolCall;
    const responsePromise = send("POST", outcome === "notification" ? notification : toolCall);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await within(entered.promise);
      if (outcome === "notification") {
        expect(vi.getTimerCount()).toBe(serverTimers);
        await vi.advanceTimersByTimeAsync(60_000);
        release.resolve();
        const response = await within(responsePromise);
        expect(response.status).toBe(202);
        expect(response.headers.get("connection")).toBe("close");
        expect(await response.text()).toBe("");
        expect(vi.getTimerCount()).toBe(serverTimers);
        return;
      }
      expect(vi.getTimerCount()).toBe(serverTimers + 1);
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await within(responsePromise);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("connection")).toBe("close");
      reader = expectDefined(response.body, "response body").getReader();
      let body = await readText(reader);
      expect(body.trim()).toBe("");
      await vi.advanceTimersByTimeAsync(30_000);
      body += await readText(reader);
      expect(body.trim()).toBe("");
      release.resolve();
      const activeReader = reader;
      body += await drain(() => within(activeReader.read()));
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
              result: { ...completed, isError: false },
            },
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(serverTimers);
    } finally {
      release.resolve();
      if (reader) {
        await reader.cancel();
      } else if (outcome !== "notification") {
        await (await responsePromise).body?.cancel();
      }
    }
  },
);

it("keeps a GET notification stream alive and releases it during shutdown", async () => {
  const send = await startClient();
  const response = await send("GET");
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("connection")).toBe("close");
  const reader = expectDefined(response.body, "notification stream").getReader();
  try {
    expect(await readText(reader)).toBe(":\n\n");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await readText(reader)).toMatch(/^(?::\n\n)+$/);
    await within(closeMcpLoopbackServer());
    const buffered = await within(drain(() => reader.read()));
    expect(buffered).toMatch(/^(?::\n\n)*$/);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});
