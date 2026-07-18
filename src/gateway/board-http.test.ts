import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryBoardStore } from "../boards/board-store.js";
import { handleBoardHttpRequest } from "./board-http.js";

const store = new InMemoryBoardStore();
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  store.putWidget({
    sessionKey: "agent:main:main",
    name: "status",
    content: { kind: "html", html: "<!doctype html><p>Status</p>" },
  });
  store.putWidget({
    sessionKey: "agent:main:main",
    name: "mcp",
    content: {
      kind: "mcp-app",
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        originSessionKey: "origin",
        toolCallId: "call",
      },
    },
  });
  server = createServer((req, res) => {
    void handleBoardHttpRequest(req, res, {
      auth: { mode: "token", token: "test-token", allowTailscale: false },
      store,
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("unhandled");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

function request(name: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({
    Authorization: "Bearer test-token",
    "x-openclaw-scopes": "operator.read",
  });
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    headers.set(key, value);
  }
  return fetch(`${baseUrl}/__openclaw__/board/agent%3Amain%3Amain/${name}/index.html`, {
    ...init,
    headers,
  });
}

describe("board widget HTTP", () => {
  it("serves authenticated HTML bytes with sandbox and no-cache headers", async () => {
    const response = await request("status");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    await expect(response.text()).resolves.toBe("<!doctype html><p>Status</p>");
  });

  it("requires gateway authentication", async () => {
    const unauthenticated = await fetch(
      `${baseUrl}/__openclaw__/board/agent%3Amain%3Amain/status/index.html`,
      { headers: { "x-openclaw-scopes": "operator.read" } },
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("returns 404 for unknown and MCP app widgets", async () => {
    expect((await request("missing")).status).toBe(404);
    expect((await request("mcp")).status).toBe(404);
  });

  it("allows GET only", async () => {
    const response = await request("status", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
