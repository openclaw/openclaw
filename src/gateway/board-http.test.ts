import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readBoardHtml, createTestBoardStore } from "../boards/board-store.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { handleBoardHttpRequest } from "./board-http.js";
import {
  BOARD_VIEW_TICKET_TTL_MS,
  createBoardViewTicket,
  verifyBoardViewTicket,
} from "./board-view-ticket.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-board-http-"));
const store = createTestBoardStore({ stateDir });
const mainSession = { sessionKey: "agent:main:main", agentId: "main" };
const nowMs = 1_800_000_000_000;
const statusHtml = "<!doctype html><p>Status 界</p>";
const gatewayA = {} as GatewayRequestContext;
const gatewayB = {} as GatewayRequestContext;
let gatewayAActive = true;
let requestGatewayContext: GatewayRequestContext | undefined = gatewayA;
let server: Server;
let baseUrl: string;
const resolveGatewayA = () => (gatewayAActive ? gatewayA : undefined);
const resolveGatewayB = () => gatewayB;
gatewayA.resolveGatewayContext = resolveGatewayA;
gatewayB.resolveGatewayContext = resolveGatewayB;
const gatewayAAuthority = {
  gatewayContext: gatewayA,
  resolveGatewayContext: resolveGatewayA,
};
const gatewayBAuthority = {
  gatewayContext: gatewayB,
  resolveGatewayContext: resolveGatewayB,
};

beforeAll(async () => {
  await store.putWidget({
    sessionKey: "agent:main:main",
    name: "status",
    content: { kind: "html", html: statusHtml },
  });
  await store.putWidget({
    sessionKey: "agent:main:main",
    name: "pending",
    content: { kind: "html", html: "pending" },
    declared: { tools: ["pending.read"] },
  });
  const rejected = await store.putWidget({
    sessionKey: "agent:main:main",
    name: "rejected",
    content: { kind: "html", html: "rejected" },
    declared: { tools: ["rejected.read"] },
  });
  await store.grant(
    mainSession,
    "rejected",
    "rejected",
    1,
    rejected.widgets.find((widget) => widget.name === "rejected")?.instanceId,
  );
  await store.putWidget({
    sessionKey: "agent:main:main",
    name: "mcp",
    content: {
      kind: "mcp-app",
      descriptor: {
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
      },
      interactive: false,
    },
  });
  await store.putWidget({
    sessionKey: "agent:main:main",
    name: "revisioned",
    content: { kind: "html", html: "<p>one</p>" },
  });
  await store.putWidget({
    sessionKey: "agent:main:main",
    name: "grantable",
    content: { kind: "html", html: "<script>pending()</script>" },
    declared: { netOrigins: ["https://example.com"] },
  });
  server = createServer((req, res) => {
    void handleBoardHttpRequest(req, res, {
      store,
      nowMs,
      resolveGatewayContext: () => requestGatewayContext,
    }).then(
      (handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end("unhandled");
        }
      },
      (error: unknown) =>
        res.destroy(new Error("Board HTTP test request failed", { cause: error })),
    );
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
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  rmSync(stateDir, { recursive: true, force: true });
});

async function ticketFor(name: string, revision = 1, issuedAtMs = nowMs): Promise<string> {
  const document = await readBoardHtml(store, mainSession, name);
  if (!document) {
    throw new Error(`missing HTML widget: ${name}`);
  }
  return issueTicket({
    sessionKey: "agent:main:main",
    name,
    revision,
    viewGeneration: document.viewGeneration,
    nowMs: issuedAtMs,
  }).ticket;
}

function issueTicket(
  params: Omit<Parameters<typeof createBoardViewTicket>[0], "authority">,
  authority: Parameters<typeof createBoardViewTicket>[0]["authority"] = gatewayAAuthority,
): ReturnType<typeof createBoardViewTicket> {
  return createBoardViewTicket({
    ...params,
    authority,
  });
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
  it("binds global widget tickets to their canonical session and selected owner", async () => {
    for (const agentId of ["main", "work"]) {
      await store.putWidget({
        sessionKey: "global",
        agentId,
        name: "global-status",
        content: { kind: "html", html: `<p>${agentId}</p>` },
      });
    }
    for (const agentId of ["main", "work"]) {
      const target = { sessionKey: "global", agentId };
      const document = (await readBoardHtml(store, target, "global-status"))!;
      const { ticket } = issueTicket({
        ...target,
        name: "global-status",
        revision: document.revision,
        viewGeneration: document.viewGeneration,
        nowMs,
      });
      const read = (owner: string) =>
        fetch(
          `${baseUrl}/__openclaw__/board/agent%3A${owner}%3Aglobal/global-status/index.html?bt=${encodeURIComponent(ticket)}`,
        );
      const response = await read(agentId);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(`<p>${agentId}</p>`);
      expect((await read(agentId === "main" ? "work" : "main")).status).toBe(401);
    }
  });

  it("serves a ticket only through its issuing live Gateway", async () => {
    gatewayAActive = true;
    requestGatewayContext = gatewayA;
    const ticket = await ticketFor("status");
    expect((await request("status", { ticket })).status).toBe(200);

    requestGatewayContext = gatewayB;
    expect((await request("status", { ticket })).status).toBe(503);
    const document = await readBoardHtml(store, mainSession, "status");
    if (!document) {
      throw new Error("missing status widget");
    }
    const replacementTicket = issueTicket(
      {
        sessionKey: "agent:main:main",
        name: "status",
        revision: document.revision,
        viewGeneration: document.viewGeneration,
        nowMs,
      },
      gatewayBAuthority,
    ).ticket;
    expect((await request("status", { ticket: replacementTicket })).status).toBe(200);

    requestGatewayContext = gatewayA;
    gatewayAActive = false;
    expect((await request("status", { ticket })).status).toBe(503);
    gatewayAActive = true;
  });

  it("round-trips self-contained claims covered by a two-minute HMAC ticket", async () => {
    const document = await readBoardHtml(store, mainSession, "status");
    if (!document || !("html" in document)) {
      throw new Error("missing status widget");
    }
    const issued = issueTicket({
      sessionKey: "agent:main:main",
      name: "status",
      revision: 1,
      viewGeneration: document.viewGeneration,
      nowMs,
    });
    expect(issued.ticket).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(issued.ticket).not.toContain("agent:main:main");
    expect(issued.expiresAtMs).toBe(nowMs + BOARD_VIEW_TICKET_TTL_MS);
    expect(verifyBoardViewTicket(issued.ticket, { nowMs })).toEqual({
      sessionKey: "agent:main:main",
      name: "status",
      revision: 1,
      viewGeneration: document.viewGeneration,
      authorityGeneration: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
      expiresAtMs: issued.expiresAtMs,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
    });
  });

  it.each([
    {
      label: "authorized multibyte HTML",
      name: "status",
      ticket: async () => await ticketFor("status"),
      status: 200,
      body: statusHtml,
      contentType: "text/html; charset=utf-8",
    },
    {
      label: "malformed encoded path",
      name: "%E0%A4%A",
      status: 404,
      body: "Not Found",
      contentType: "text/plain; charset=utf-8",
    },
    {
      label: "missing ticket",
      name: "status",
      status: 401,
      body: "Unauthorized",
      contentType: "text/plain; charset=utf-8",
    },
  ])("preserves GET metadata while suppressing the HEAD body for $label", async (testCase) => {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await request(testCase.name, {
        method,
        ticket: await testCase.ticket?.(),
      });
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(testCase.status);
      expect(response.headers.get("content-type")).toBe(testCase.contentType);
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(testCase.body)));
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(body).toEqual(method === "GET" ? Buffer.from(testCase.body) : Buffer.alloc(0));

      if (testCase.status === 200) {
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
        expect(response.headers.get("content-security-policy")).toContain("webrtc 'block'");
        expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }
    }
  });

  it("does not require or inspect an operator token", async () => {
    const response = await request("status", {
      ticket: await ticketFor("status"),
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
  });

  it("rejects garbage and expired tickets before reading the store", async () => {
    const expired = await ticketFor("status", 1, nowMs - BOARD_VIEW_TICKET_TTL_MS - 1);
    const valid = await ticketFor("status");
    const readSpy = vi.spyOn(store, "useWidgetDocument");
    expect((await request("status")).status).toBe(401);
    const garbage = await request("status", { ticket: "garbage" });
    expect(garbage.status).toBe(401);
    expect(garbage.headers.get("access-control-allow-origin")).toBe("*");
    expect((await request("status", { ticket: `${valid.slice(0, -1)}x` })).status).toBe(401);
    expect((await request("status", { ticket: expired })).status).toBe(401);
    expect(readSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("withholds delayed HTML when the serving Gateway retires during its read", async () => {
    const ticket = await ticketFor("status");
    const started = createDeferred();
    const release = createDeferred();
    const read = store.useWidgetDocument.bind(store);
    const readSpy = vi.spyOn(store, "useWidgetDocument").mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return await read(...args);
    });
    const pending = request("status", { ticket });
    try {
      await started.promise;
      gatewayAActive = false;
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Service Unavailable");
    } finally {
      release.resolve();
      await pending;
      gatewayAActive = true;
      readSpy.mockRestore();
    }
  });

  it("sends widget HTML in the authorized read turn before a queued removal", async () => {
    await store.putWidget({
      ...mainSession,
      name: "handoff",
      content: { kind: "html", html: "handoff" },
    });
    const ticket = await ticketFor("handoff");
    const order: string[] = [];
    const removed = createDeferred();
    server.prependOnceListener("request", (_req, res) => {
      res.once("finish", () => order.push("sent"));
    });
    const read = store.useWidgetDocument.bind(store);
    const readSpy = vi
      .spyOn(store, "useWidgetDocument")
      .mockImplementationOnce((target, name, consume) =>
        read(target, name, (document) => {
          queueMicrotask(() => {
            order.push("removal");
            void store
              .applyOps(target, [{ kind: "widget_remove", name }])
              .then(() => removed.resolve(), removed.reject);
          });
          return consume(document);
        }),
      );
    try {
      const response = await request("handoff", { ticket });
      await removed.promise;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("handoff");
      expect(order).toEqual(["sent", "removal"]);
      expect(await readBoardHtml(store, mainSession, "handoff")).toBeUndefined();
    } finally {
      readSpy.mockRestore();
    }
  });

  it("withholds declared widget bytes until the operator grants them", async () => {
    const ticket = await ticketFor("grantable");
    expect((await request("grantable", { ticket })).status).toBe(401);

    await store.grant(
      mainSession,
      "grantable",
      "granted",
      1,
      (await store.getSnapshot(mainSession)).widgets.find((widget) => widget.name === "grantable")
        ?.instanceId,
    );
    const response = await request("grantable", { ticket });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src https://example.com",
    );
    await expect(response.text()).resolves.toBe("<script>pending()</script>");
  });

  it("rejects a ticket after the widget revision changes", async () => {
    const stale = await ticketFor("revisioned");
    await store.putWidget({
      sessionKey: "agent:main:main",
      name: "revisioned",
      content: { kind: "html", html: "<p>two</p>" },
    });
    expect((await request("revisioned", { ticket: stale })).status).toBe(401);
    const current = await request("revisioned", { ticket: await ticketFor("revisioned", 2) });
    expect(current.status).toBe(200);
    await expect(current.text()).resolves.toBe("<p>two</p>");
  });

  it("rejects a stale ticket when a widget name and revision are reused", async () => {
    await store.putWidget({
      sessionKey: "agent:main:main",
      name: "recreated",
      content: { kind: "html", html: "<p>old</p>" },
    });
    const stale = await ticketFor("recreated");
    await store.applyOps(mainSession, [{ kind: "widget_remove", name: "recreated" }]);
    await store.putWidget({
      sessionKey: "agent:main:main",
      name: "recreated",
      content: { kind: "html", html: "<p>old</p>" },
    });

    expect((await request("recreated", { ticket: stale })).status).toBe(401);
    expect((await request("recreated", { ticket: await ticketFor("recreated") })).status).toBe(200);
  });

  it("rejects a ticket with a stale view generation", async () => {
    const ticket = issueTicket({
      sessionKey: "agent:main:main",
      name: "status",
      revision: 1,
      viewGeneration: "0".repeat(32),
      nowMs,
    }).ticket;
    expect((await request("status", { ticket })).status).toBe(401);
  });

  it("refuses pending and rejected widgets even with valid tickets", async () => {
    expect((await request("pending", { ticket: await ticketFor("pending") })).status).toBe(401);
    expect((await request("rejected", { ticket: await ticketFor("rejected") })).status).toBe(401);
  });

  it("serves an encoded slash as part of an opaque session key", async () => {
    await store.putWidget({
      sessionKey: "session/with/slash",
      name: "slash-key",
      content: { kind: "html", html: "slash" },
    });
    const document = await readBoardHtml(
      store,
      { sessionKey: "session/with/slash", agentId: "main" },
      "slash-key",
    );
    if (!document || !("html" in document)) {
      throw new Error("missing slash-key widget");
    }
    const ticket = issueTicket({
      sessionKey: "session/with/slash",
      name: "slash-key",
      revision: 1,
      viewGeneration: document.viewGeneration,
      nowMs,
    }).ticket;
    const response = await fetch(
      `${baseUrl}/__openclaw__/board/session%2Fwith%2Fslash/slash-key/index.html?bt=${encodeURIComponent(ticket)}`,
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("slash");
  });

  it("returns 401 when valid claims have no matching HTML document", async () => {
    const ticket = issueTicket({
      sessionKey: "agent:main:main",
      name: "missing",
      revision: 1,
      viewGeneration: "0".repeat(32),
      nowMs,
    }).ticket;
    expect((await request("missing", { ticket })).status).toBe(401);
    const mcpTicket = issueTicket({
      sessionKey: "agent:main:main",
      name: "mcp",
      revision: 1,
      viewGeneration: "0".repeat(32),
      nowMs,
    }).ticket;
    expect((await request("mcp", { ticket: mcpTicket })).status).toBe(401);
  });

  it("allows GET and HEAD only", async () => {
    const response = await request("status", { method: "POST", ticket: await ticketFor("status") });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
