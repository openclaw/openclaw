import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryBoardStore } from "../boards/board-store.js";
import { handleBoardHttpRequest } from "./board-http.js";
import {
  BOARD_VIEW_TICKET_TTL_MS,
  createBoardViewTicket,
  verifyBoardViewTicket,
} from "./board-view-ticket.js";

const store = new InMemoryBoardStore();
const nowMs = 1_800_000_000_000;
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
  store.putWidget({
    sessionKey: "agent:main:main",
    name: "revisioned",
    content: { kind: "html", html: "<p>one</p>" },
  });
  server = createServer((req, res) => {
    const handled = handleBoardHttpRequest(req, res, {
      store,
      nowMs,
    });
    if (!handled) {
      res.statusCode = 404;
      res.end("unhandled");
    }
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

function ticketFor(name: string, revision = 1, issuedAtMs = nowMs): string {
  const document = store.readWidgetHtml("agent:main:main", name);
  if (!document || !("html" in document)) {
    throw new Error(`missing HTML widget: ${name}`);
  }
  return createBoardViewTicket({
    sessionKey: "agent:main:main",
    name,
    revision,
    sha256: document.sha256,
    viewGeneration: document.viewGeneration,
    nowMs: issuedAtMs,
  }).ticket;
}

function request(
  name: string,
  init: { method?: string; headers?: Record<string, string>; ticket?: string } = {},
) {
  const query = init.ticket ? `?bt=${encodeURIComponent(init.ticket)}` : "";
  return fetch(`${baseUrl}/__openclaw__/board/agent%3Amain%3Amain/${name}/index.html${query}`, {
    method: init.method,
    headers: init.headers,
  });
}

describe("board widget HTTP", () => {
  it("round-trips an opaque two-minute ticket bound to the widget revision", () => {
    const document = store.readWidgetHtml("agent:main:main", "status");
    if (!document || !("html" in document)) {
      throw new Error("missing status widget");
    }
    const issued = createBoardViewTicket({
      sessionKey: "agent:main:main",
      name: "status",
      revision: 1,
      sha256: document.sha256,
      viewGeneration: document.viewGeneration,
      nowMs,
    });
    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + BOARD_VIEW_TICKET_TTL_MS);
    expect(
      verifyBoardViewTicket(issued.ticket, {
        sessionKey: "agent:other:main",
        name: "status",
        revision: 1,
        sha256: document.sha256,
        viewGeneration: document.viewGeneration,
        nowMs,
      }),
    ).toBeUndefined();
    expect(
      verifyBoardViewTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        name: "other",
        revision: 1,
        sha256: document.sha256,
        viewGeneration: document.viewGeneration,
        nowMs,
      }),
    ).toBeUndefined();
    expect(
      verifyBoardViewTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        name: "status",
        revision: 1,
        sha256: document.sha256,
        viewGeneration: document.viewGeneration,
        nowMs,
      }),
    ).toEqual({
      sessionKey: "agent:main:main",
      name: "status",
      revision: 1,
      sha256: document.sha256,
      viewGeneration: document.viewGeneration,
      expiresAtMs: issued.expiresAtMs,
    });
    expect(
      verifyBoardViewTicket(issued.ticket, {
        sessionKey: "agent:main:main",
        name: "status",
        revision: 2,
        sha256: document.sha256,
        viewGeneration: document.viewGeneration,
        nowMs,
      }),
    ).toBeUndefined();
  });

  it("serves HTML bytes with a valid ticket and no gateway auth", async () => {
    const response = await request("status", { ticket: ticketFor("status") });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    await expect(response.text()).resolves.toBe("<!doctype html><p>Status</p>");
  });

  it("does not require or inspect an operator token", async () => {
    const response = await request("status", {
      ticket: ticketFor("status"),
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
  });

  it("rejects missing, tampered, and expired tickets", async () => {
    expect((await request("status")).status).toBe(401);
    const ticket = ticketFor("status");
    expect((await request("status", { ticket: `${ticket.slice(0, -1)}x` })).status).toBe(401);
    const expired = ticketFor("status", 1, nowMs - BOARD_VIEW_TICKET_TTL_MS - 1);
    expect((await request("status", { ticket: expired })).status).toBe(401);
  });

  it("rejects a ticket after the widget revision changes", async () => {
    const stale = ticketFor("revisioned");
    store.putWidget({
      sessionKey: "agent:main:main",
      name: "revisioned",
      content: { kind: "html", html: "<p>two</p>" },
    });
    expect((await request("revisioned", { ticket: stale })).status).toBe(401);
    const current = await request("revisioned", { ticket: ticketFor("revisioned", 2) });
    expect(current.status).toBe(200);
    await expect(current.text()).resolves.toBe("<p>two</p>");
  });

  it("rejects a stale ticket when a widget name and revision are reused", async () => {
    store.putWidget({
      sessionKey: "agent:main:main",
      name: "recreated",
      content: { kind: "html", html: "<p>old</p>" },
    });
    const stale = ticketFor("recreated");
    store.applyOps("agent:main:main", [{ kind: "widget_remove", name: "recreated" }]);
    store.putWidget({
      sessionKey: "agent:main:main",
      name: "recreated",
      content: { kind: "html", html: "<p>old</p>" },
    });

    expect((await request("recreated", { ticket: stale })).status).toBe(401);
    expect((await request("recreated", { ticket: ticketFor("recreated") })).status).toBe(200);
  });

  it("serves an encoded slash as part of an opaque session key", async () => {
    store.putWidget({
      sessionKey: "session/with/slash",
      name: "slash-key",
      content: { kind: "html", html: "slash" },
    });
    const document = store.readWidgetHtml("session/with/slash", "slash-key");
    if (!document || !("html" in document)) {
      throw new Error("missing slash-key widget");
    }
    const ticket = createBoardViewTicket({
      sessionKey: "session/with/slash",
      name: "slash-key",
      revision: 1,
      sha256: document.sha256,
      viewGeneration: document.viewGeneration,
      nowMs,
    }).ticket;
    const response = await fetch(
      `${baseUrl}/__openclaw__/board/session%2Fwith%2Fslash/slash-key/index.html?bt=${encodeURIComponent(ticket)}`,
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("slash");
  });

  it("returns 404 for unknown and MCP app widgets", async () => {
    expect((await request("missing")).status).toBe(404);
    expect((await request("mcp")).status).toBe(404);
  });

  it("allows GET only", async () => {
    const response = await request("status", { method: "POST", ticket: ticketFor("status") });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
