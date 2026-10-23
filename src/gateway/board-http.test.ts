import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { readBoardHtml, createTestBoardStore } from "../boards/board-store.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { handleBoardHttpRequest } from "./board-http.js";
import { BOARD_VIEW_TICKET_TTL_MS, createBoardViewTicket } from "./board-view-ticket.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
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
function authorityFor(
  context: GatewayRequestContext,
  resolveGatewayContext: NonNullable<GatewayRequestContext["resolveGatewayContext"]> = () =>
    context,
) {
  context.resolveGatewayContext = resolveGatewayContext;
  return { gatewayContext: context, resolveGatewayContext };
}
const gatewayAAuthority = authorityFor(gatewayA, () => (gatewayAActive ? gatewayA : undefined));
const gatewayBAuthority = authorityFor(gatewayB);

beforeAll(async () => {
  await putHtml("status", statusHtml);
  await putHtml("grantable", "<script>pending()</script>", {
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
  baseUrl = await listenLoopback(server);
});

afterAll(async () => {
  await closeHttpServer(server);
  await closeOpenClawAgentDatabasesAsync(stateDir);
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  rmSync(stateDir, { recursive: true, force: true });
});

function putHtml(
  name: string,
  html: string,
  options: Partial<Parameters<typeof store.putWidget>[0]> = {},
) {
  return store.putWidget({
    sessionKey: mainSession.sessionKey,
    name,
    content: { kind: "html", html },
    ...options,
  });
}

async function ticketFor(
  name: string,
  options: Partial<Parameters<typeof createBoardViewTicket>[0]> = {},
): Promise<string> {
  const target = { sessionKey: mainSession.sessionKey, ...options };
  const document = await readBoardHtml(store, target, name);
  if (!document) {
    throw new Error(`missing HTML widget: ${name}`);
  }
  return createBoardViewTicket({
    ...target,
    name,
    revision: 1,
    viewGeneration: document.viewGeneration,
    nowMs,
    authority: gatewayAAuthority,
    ...options,
  }).ticket;
}

function request(name: string, init: { method?: string; ticket?: string } = {}) {
  const query = init.ticket ? `?bt=${encodeURIComponent(init.ticket)}` : "";
  const url = `${baseUrl}/__openclaw__/board/agent%3Amain%3Amain/${name}/index.html${query}`;
  return fetch(url, { method: init.method });
}

describe("board widget HTTP", () => {
  it("fences direct-listener replay of an ingress ticket when its grant ends", async () => {
    const grant = new AbortController();
    const ingress = createRemoteControlUiIngressTestContext({ signal: grant.signal });
    const ticket = await ticketFor("status", {
      authority: { ...gatewayAAuthority, remoteIngressPrincipal: ingress.resolvePrincipal() },
    });
    expect((await request("status", { ticket })).status).toBe(200);
    grant.abort();
    expect((await request("status", { ticket })).status).toBe(503);
  });
  it("binds global widget tickets to their canonical session and selected owner", async () => {
    for (const agentId of ["main", "work"]) {
      await putHtml("global-status", `<p>${agentId}</p>`, {
        sessionKey: "global",
        agentId,
      });
    }
    for (const agentId of ["main", "work"]) {
      const target = { sessionKey: "global", agentId };
      const ticket = await ticketFor("global-status", target);
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
    const replacementTicket = await ticketFor("status", { authority: gatewayBAuthority });
    expect((await request("status", { ticket: replacementTicket })).status).toBe(200);

    requestGatewayContext = gatewayA;
    gatewayAActive = false;
    expect((await request("status", { ticket })).status).toBe(503);
    gatewayAActive = true;
  });

  it.each([
    ["status", 200, statusHtml, "text/html; charset=utf-8"],
    ["%E0%A4%A", 404, "Not Found", "text/plain; charset=utf-8"],
  ] as const)("preserves GET/HEAD metadata for %s", async (name, status, html, contentType) => {
    for (const method of ["GET", "HEAD"] as const) {
      const ticket = status === 200 ? await ticketFor(name) : undefined;
      const host = observeHostDataSql();
      let response: Response;
      try {
        response = await request(name, { method, ticket });
        expect(
          host.queries.filter((sql) => /\bfrom\s+"?board_(?:tabs|widgets)"?\b/iu.test(sql)),
        ).toEqual([]);
      } finally {
        host.restore();
      }
      const body = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(body).toEqual(method === "GET" ? Buffer.from(html) : Buffer.alloc(0));

      if (status === 200) {
        const csp = response.headers.get("content-security-policy");
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("connect-src 'none'");
        expect(csp).toContain("webrtc 'block'");
        expect(csp).toContain("sandbox allow-scripts");
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }
    }
  });

  it("rejects garbage and expired tickets before reading the store", async () => {
    const expired = await ticketFor("status", { nowMs: nowMs - BOARD_VIEW_TICKET_TTL_MS - 1 });
    const valid = await ticketFor("status");
    const readSpy = vi.spyOn(store, "useWidgetDocument");
    for (const ticket of [undefined, "garbage", `${valid.slice(0, -1)}x`, expired]) {
      const response = await request("status", { ticket });
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
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
    await putHtml("handoff", "handoff");
    const ticket = await ticketFor("handoff");
    let servingResponse: ServerResponse | undefined;
    let responseEndedBeforeRemoval = false;
    const removed = createDeferred();
    server.prependOnceListener("request", (_req, res) => {
      servingResponse = res;
    });
    const read = store.useWidgetDocument.bind(store);
    const readSpy = vi
      .spyOn(store, "useWidgetDocument")
      .mockImplementationOnce((target, name, consume) =>
        read(target, name, (document) => {
          queueMicrotask(() => {
            responseEndedBeforeRemoval = servingResponse?.writableEnded === true;
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
      expect(responseEndedBeforeRemoval).toBe(true);
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

  it.each([false, true])("invalidates old widget tickets, recreated=%s", async (recreated) => {
    const name = recreated ? "recreated" : "revisioned";
    await putHtml(name, "<p>old</p>");
    const stale = await ticketFor(name);
    if (recreated) {
      await store.applyOps(mainSession, [{ kind: "widget_remove", name }]);
    }
    const html = recreated ? "<p>old</p>" : "<p>two</p>";
    await putHtml(name, html);
    expect((await request(name, { ticket: stale })).status).toBe(401);
    const current = await request(name, {
      ticket: await ticketFor(name, { revision: recreated ? 1 : 2 }),
    });
    expect(current.status).toBe(200);
    await expect(current.text()).resolves.toBe(html);
  });

  it("allows GET and HEAD only", async () => {
    const response = await request("status", { method: "POST", ticket: await ticketFor("status") });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
