import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { text as readBody } from "node:stream/consumers";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
} from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthPendingAuthorization } from "../agents/mcp-oauth-store.js";
import { readMcpOAuthCredentialsStatus } from "../agents/mcp-oauth.js";
import { seedMcpOAuthStoreForTest } from "../agents/mcp-oauth.test-support.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getFreePort } from "../test-utils/ports.js";
import { registerMcpCli } from "./mcp-cli.js";

function createCli() {
  const program = new Command().exitOverride();
  registerMcpCli(program);
  const run = (...args: string[]) => program.parseAsync(["mcp", ...args], { from: "user" });
  return { run, set: (server: object) => run("set", "fixture", JSON.stringify(server)) };
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
const oauthTokens = (access_token: string, refresh_token?: string) => ({
  access_token,
  refresh_token,
  token_type: "Bearer",
  expires_in: 3600,
});
const oauthServer = (url: string, oauth?: object) => ({
  url,
  transport: "streamable-http",
  auth: "oauth",
  ...(oauth ? { oauth } : {}),
});

async function startOAuthFixture() {
  let issuer = "";
  let codeChallenge: string | undefined;
  let tokenRedirectUri: string | undefined;
  let tokenVerifier: string | undefined;
  const mcpRequests: Array<Pick<IncomingMessage, "headers"> & { body: string }> = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return sendJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return sendJson(response, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = JSON.parse(await readBody(request)) as { redirect_uris?: string[] };
      const redirectUris = metadata.redirect_uris?.map((value) => {
        const redirect = new URL(value);
        redirect.port = "";
        return redirect.href;
      });
      return sendJson(
        response,
        { ...metadata, redirect_uris: redirectUris, client_id: "fixture-client" },
        201,
      );
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
      if (!redirectUri || !state || !codeChallenge) {
        return sendJson(response, { error: "invalid_request" }, 400);
      }
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", state);
      return response.writeHead(302, { Location: callback.toString() }).end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== "fixture-refresh-token") {
          return sendJson(response, { error: "invalid_grant" }, 400);
        }
        return sendJson(response, oauthTokens("fixture-refreshed-access-token"));
      }
      tokenRedirectUri = form.get("redirect_uri") ?? undefined;
      tokenVerifier = form.get("code_verifier") ?? undefined;
      const challenge = tokenVerifier
        ? createHash("sha256").update(tokenVerifier).digest("base64url")
        : undefined;
      if (form.get("code") !== "fixture-code" || challenge !== codeChallenge) {
        return sendJson(response, { error: "invalid_grant" }, 400);
      }
      return sendJson(response, oauthTokens("fixture-access-token", "fixture-refresh-token"));
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const body = await readBody(request);
      mcpRequests.push({ headers: request.headers, body });
      if (request.headers["content-length"] === undefined) {
        return response
          .writeHead(411, { "Content-Type": "text/plain" })
          .end("Content-Length required");
      }
      if (mcpRequests.length === 1) {
        return response
          .writeHead(401, {
            "Content-Type": "text/plain",
            "WWW-Authenticate": 'Bearer scope="docs.read"',
          })
          .end("expired token");
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      const reply = (result: unknown) =>
        sendJson(response, { jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") {
        return reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        });
      }
      if (message.method === "notifications/initialized") {
        return response.writeHead(202, { "Content-Length": "0" }).end();
      }
      if (message.method === "tools/list") {
        return reply({ tools: [{ name: "read_page", inputSchema: { type: "object" } }] });
      }
    }
    response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("OAuth fixture failed"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("OAuth fixture did not bind a TCP address");
  }
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer,
    close,
    exchange: () => ({ tokenRedirectUri, tokenVerifier }),
    mcpRequests: () => mcpRequests,
  };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it("keeps per-requester list, status, and doctor probes read only", async () => {
  await withTempHome(`openclaw-mcp-read-only-${randomUUID()}-`, async () => {
    const logs: string[] = [];
    const json: unknown[] = [];
    vi.spyOn(defaultRuntime, "log").mockImplementation((line) => logs.push(String(line)));
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => json.push(value));
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    const { run, set } = createCli();
    await set(oauthServer("https://mcp.example.com/rpc", { identity: "per-requester" }));
    logs.length = 0;

    await run("list");
    expect(logs).toContain("- fixture (0 connected principals)");
    logs.length = 0;
    await run("status", "--json");
    expect(json.at(-1)).toMatchObject({
      servers: [{ name: "fixture", connectedPrincipals: 0 }],
    });
    json.length = 0;
    await expect(run("doctor", "--probe", "--json")).rejects.toMatchObject({ code: 1 });
    expect(exit).not.toHaveBeenCalled();
    expect(captureGatewayStateOwner(resolveOpenClawStateSqlitePath())).toBeUndefined();
    expect(json.at(-1)).toMatchObject({ servers: [{ name: "fixture" }] });
    withOpenClawStateDatabaseReadOnly(({ db }) => {
      expect(db.prepare("SELECT count(*) AS count FROM mcp_oauth_stores").get()).toEqual({
        count: 0,
      });
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("mcp_oauth_pending_authorizations"),
      ).toBeUndefined();
    });
  });
});

it("clears requester credentials when the same URL changes to shared OAuth", async () => {
  await withTempHome(`openclaw-mcp-identity-flip-${randomUUID()}-`, async () => {
    const serverUrl = "https://mcp.example.com/rpc";
    const { set } = createCli();
    await set(oauthServer(serverUrl, { identity: "per-requester" }));
    const operator = operatorMcpOAuthIdentity("fixture", serverUrl);
    const requester = requesterMcpOAuthIdentity("fixture", serverUrl, {
      requesterSenderId: "alice",
      messageChannel: "telegram",
    });
    for (const identity of [operator, requester]) {
      seedMcpOAuthStoreForTest(
        identity.storeKey,
        {
          tokens: { access_token: identity.principal, token_type: "Bearer" },
        },
        identity === requester ? "requester-state" : undefined,
      );
    }

    await set(oauthServer(serverUrl));

    await expect(readMcpOAuthCredentialsStatus(requester)).resolves.toEqual({
      state: "unauthenticated",
    });
    await expect(readMcpOAuthCredentialsStatus(operator)).resolves.toEqual({ state: "authorized" });
    expect(await readMcpOAuthPendingAuthorization("requester-state")).toBeUndefined();
  });
});

it("logs in and probes through the CLI with a portless loopback registration", async () => {
  await withTempHome(`openclaw-mcp-login-${randomUUID()}-`, async () => {
    const fixture = await startOAuthFixture();
    try {
      const identity = operatorMcpOAuthIdentity("fixture", `${fixture.issuer}/mcp`);
      const expectAuth = (state: string) =>
        expect(readMcpOAuthCredentialsStatus(identity)).resolves.toMatchObject({ state });
      const callbackPort = await getFreePort();
      const redirectUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;
      const logs: string[] = [];
      const authorizationUrl = createDeferred<string>();
      vi.spyOn(defaultRuntime, "log").mockImplementation((line) => {
        const text = String(line);
        logs.push(text);
        if (text.startsWith(`${fixture.issuer}/authorize`)) {
          authorizationUrl.resolve(text);
        }
      });
      const { run, set } = createCli();
      await set(oauthServer(`${fixture.issuer}/mcp`, { redirectUrl }));
      logs.length = 0;

      // Drive the browser from the published URL, not a polling deadline that
      // can abandon login while discovery still owns the temporary state.
      const browser = authorizationUrl.promise.then(async (url) => {
        const response = await fetch(url);
        return { status: response.status, body: await response.text() };
      });
      const [browserResponse] = await Promise.all([browser, run("login", "fixture")]);
      expect(logs.some((line) => line.includes("Waiting for the browser"))).toBe(true);
      expect(browserResponse).toEqual({
        status: 200,
        body: expect.stringContaining("Authorization received"),
      });

      await expectAuth("authorized");
      expect(fixture.exchange()).toMatchObject({
        tokenRedirectUri: redirectUrl,
        tokenVerifier: expect.any(String),
      });
      expect(logs).toContain('MCP OAuth credentials saved for "fixture".');

      logs.length = 0;
      await run("probe", "fixture");
      expect(logs).toContain("- fixture: 1 tools, Codex approval auto");
      const requests = fixture.mcpRequests();
      expect(requests.map((request) => JSON.parse(request.body).method)).toEqual([
        "initialize",
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(requests[0]?.body).toBe(requests[1]?.body);
      for (const request of requests) {
        expect(request.headers["content-length"]).toBe(String(Buffer.byteLength(request.body)));
        expect(request.headers["transfer-encoding"]).toBeUndefined();
      }
      expect(requests[0]?.headers.authorization).toBe("Bearer fixture-access-token");
      expect(requests.slice(1).map((request) => request.headers.authorization)).toEqual(
        Array(3).fill("Bearer fixture-refreshed-access-token"),
      );
      // A live owner must keep this CLI from refreshing or clearing its credentials.
      const discover = vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
        pid: process.pid,
        ownerId: "synthetic-other-process-owner",
        createdAt: new Date(0).toISOString(),
        port: 1,
      });
      const requestCount = fixture.mcpRequests().length;
      try {
        for (const args of [
          ["login", "fixture", "--code", "fixture-code"],
          ["logout", "fixture"],
          ["probe", "fixture"],
          ["doctor", "fixture", "--probe"],
          ["set", "fixture", '{"url":"https://replacement.example.com"}'],
          ["configure", "fixture", "--clear-auth"],
          ["tools", "fixture", "--clear"],
          ["unset", "fixture"],
        ]) {
          await expect(run(...args)).rejects.toMatchObject({
            code: "OWNER_UNAVAILABLE",
            message: expect.stringContaining("stop the Gateway"),
          });
        }
        expect(fixture.mcpRequests()).toHaveLength(requestCount);
        await expectAuth("authorized");
        await run("doctor", "fixture");
      } finally {
        discover.mockRestore();
      }
      await run("logout", "fixture");
      await expectAuth("unauthenticated");
      await expect(fetch(redirectUrl)).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });
});
