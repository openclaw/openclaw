import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import type { WebSocket } from "ws";
import type {
  WizardNextResult,
  WizardStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import { mcpAuthLoginHandlers } from "./server-methods/mcp-auth-login.js";
import { mcpAuthLogoutHandlers } from "./server-methods/mcp-auth-logout.js";
import { whenAdmittedWizardSessionSettled } from "./server-methods/setup-admission.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  mcpOAuthMetadata,
  type McpAuthEffectEndpoint,
} from "./server.mcp-auth-login.forced-effects.test-support.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

export function installMcpAuthLoginSuite() {
  installGatewayTestHooks({ scope: "suite" });
  let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
  let gatewayPort: number;
  let owner: WebSocket;
  let other: WebSocket;
  let readOnly: WebSocket;
  let resourceUrl: string;
  let config: McpServerConfig;
  let expectedChallenge: string;
  let registeredRedirect: string;
  let tokenError: "invalid_client" | false = false;
  let issuerRequired = false;
  const effects: McpAuthEffectEndpoint = { tokenLifetimeSeconds: 3600 };
  let tokenEntered = createDeferredCore();
  let releaseToken: Deferred | undefined;
  let redirectStage: "register" | "token" | undefined;
  let redirectEntered = createDeferredCore();
  let releaseRedirect: Deferred | undefined;
  let admitted: GatewayRequestHandlerOptions | undefined;
  let beforeLogin: ((request: GatewayRequestHandlerOptions) => Promise<void>) | undefined;
  let admissionSettled = createDeferredCore();
  let discoveryEntered = createDeferredCore();
  let logoutRequest: GatewayRequestHandlerOptions | undefined;
  let logoutEntered: Deferred | undefined;
  let releaseDiscovery: Deferred | undefined;
  const requests: string[] = [];
  const endpoint = createServer((request, response) => {
    void (async () => {
      const json = (value: unknown, code = 200) =>
        response.writeHead(code).end(JSON.stringify(value));
      const url = new URL(request.url ?? "/", resourceUrl);
      requests.push(url.pathname);
      response.setHeader("Content-Type", "application/json");
      if (effects.endpoint && (await effects.endpoint(request, response))) {
        return;
      }
      if (redirectStage && url.pathname === `/${redirectStage}`) {
        redirectEntered.resolve();
        await releaseRedirect?.promise;
        response.writeHead(307, { Location: `/${redirectStage}-final` }).end();
        return;
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        discoveryEntered.resolve();
        await releaseDiscovery?.promise;
        json({ resource: resourceUrl, authorization_servers: [new URL(resourceUrl).origin] });
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({
          ...mcpOAuthMetadata(resourceUrl),
          authorization_response_iss_parameter_supported: issuerRequired,
        });
      } else if (url.pathname === "/register") {
        const metadata = JSON.parse(await text(request));
        registeredRedirect = metadata.redirect_uris[0];
        json({ ...metadata, client_id: "fixture-client" });
      } else if (url.pathname === "/token") {
        const params = new URLSearchParams(await text(request));
        tokenEntered.resolve();
        if (releaseToken) {
          await releaseToken.promise;
        }
        if (tokenError) {
          json({ error: tokenError, error_description: "private exchange detail" }, 400);
        } else if (
          params.get("code") !== "fixture-code" ||
          params.get("redirect_uri") !== registeredRedirect ||
          createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url") !== expectedChallenge
        ) {
          json({ error: "invalid_grant" }, 400);
        } else {
          json({
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            token_type: "Bearer",
            expires_in: effects.tokenLifetimeSeconds,
          });
        }
      } else if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer fixture-access") {
          response
            .writeHead(401, {
              "www-authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", resourceUrl).href}"`,
            })
            .end();
          return;
        }
        const body = await text(request);
        if (!body) {
          response.writeHead(405).end();
          return;
        }
        const message = JSON.parse(body);
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1.0.0" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "echo",
                      description: "Returns a fixture reply",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "Authenticated connector reply" }] };
        json({ jsonrpc: "2.0", id: message.id, result });
      } else {
        response.writeHead(404).end();
      }
    })().catch(() => response.writeHead(500).end());
  });

  beforeAll(async () => {
    const login = expectDefined(mcpAuthLoginHandlers["mcp.authLogin"], "registered login handler");
    vi.spyOn(mcpAuthLoginHandlers, "mcp.authLogin").mockImplementation(async (request) => {
      admitted = request;
      try {
        await beforeLogin?.(request);
        await login(request);
      } finally {
        admissionSettled.resolve();
      }
    });
    const logout = expectDefined(
      mcpAuthLogoutHandlers["mcp.authLogout"],
      "registered logout handler",
    );
    vi.spyOn(mcpAuthLogoutHandlers, "mcp.authLogout").mockImplementation(async (request) => {
      logoutRequest = request;
      // The handler has passed its synchronous checks before the test observes entry.
      const running = logout(request);
      logoutEntered?.resolve();
      await running;
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture listener unavailable");
    }
    resourceUrl = `http://127.0.0.1:${address.port}/mcp`;
    config = { url: resourceUrl, transport: "streamable-http", auth: "oauth" };
    gatewayPort = await getFreePort();
    await configure();
    gateway = await createGatewaySuiteHarness({
      port: gatewayPort,
      serverOptions: { bind: "loopback", auth: { mode: "none" } },
    });
    await gateway.server.startupSettled;
    owner = await connect(["operator.admin"]);
    other = await connect(["operator.admin"]);
    readOnly = await connect(["operator.read"]);
  });

  afterAll(async () => {
    releaseToken?.resolve();
    releaseRedirect?.resolve();
    releaseDiscovery?.resolve();
    owner?.close();
    other?.close();
    readOnly?.close();
    await gateway?.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve());
    });
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    issuerRequired = false;
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
  });

  const identity = () => operatorMcpOAuthIdentity("docs", resourceUrl);
  const store = () => readMcpOAuthStore(identity().storeKey);
  const login = (client = owner, sessionId = randomUUID(), extra: Record<string, string> = {}) =>
    rpcReq<WizardStartResult>(client, "mcp.authLogin", { sessionId, serverName: "docs", ...extra });
  const configure = (server = config, origin?: string) =>
    writeConfigFile({
      gateway: {
        port: gatewayPort,
        reload: { mode: "off" },
        ...(origin ? { controlUi: { allowedOrigins: [origin] } } : {}),
      },
      mcp: { servers: { docs: server } },
    });
  const getInvocation = () => expectDefined(admitted, "admitted request");
  const registryGetter = () =>
    expectDefined(getInvocation().context.getGatewayMethodRegistry, "selected registry getter");
  const getSession = (sessionId: string) =>
    expectDefined(getInvocation().context.wizardSessions.get(sessionId), "admitted wizard");
  function resolverRegistry() {
    const registry = createEmptyPluginRegistry();
    registry.mcpServerConnectionResolvers.push({
      pluginId: "fixture-resolver",
      source: "mcp-auth-login-fixture",
      resolver: { serverName: "docs", resolve: async () => ({ url: resourceUrl }) },
    });
    return registry;
  }
  const expectPendingCleared = (stored: Awaited<ReturnType<typeof store>>) =>
    expect([stored.codeVerifier, stored.lastAuthorizationUrl]).toEqual([undefined, undefined]);
  async function expectSettled(session: ReturnType<typeof getSession>) {
    await whenAdmittedWizardSessionSettled(session);
    expect(session.getStatus()).toBe("error");
  }
  function resolvedTransport() {
    const resolved = resolveMcpTransportConfig("docs", config);
    if (resolved?.kind !== "http") {
      throw new Error("Fixture transport unavailable");
    }
    return resolved;
  }
  async function connect(scopes: string[], origin = `http://127.0.0.1:${gateway.port}`) {
    const client = await gateway.openWs({ origin });
    await connectOk(client, {
      scopes,
      deviceIdentityPath: path.join(
        resolveStateDir(),
        `connector-${randomUUID()}`,
        "client",
        "credentials.sqlite",
      ),
      browserOrigin: origin,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "test",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    return client;
  }
  async function startLogin(client = owner) {
    const sessionId = randomUUID();
    const started = await login(client, sessionId);
    expect(started, JSON.stringify(started.error)).toMatchObject({
      ok: true,
      payload: { sessionId, done: false, status: "running" },
    });
    return sessionId;
  }
  async function begin(client = owner) {
    const sessionId = await startLogin(client);
    while (true) {
      const next = await rpcReq<WizardNextResult>(client, "wizard.next", { sessionId });
      expect(next.ok, JSON.stringify(next.error)).toBe(true);
      const result = expectDefined(next.payload, "wizard result");
      expect(result.done, result.error).toBe(false);
      if (result.step?.externalUrl) {
        const authorization = new URL(result.step.externalUrl);
        expectedChallenge = expectDefined(
          authorization.searchParams.get("code_challenge"),
          "PKCE challenge",
        );
        return {
          sessionId,
          state: expectDefined(authorization.searchParams.get("state"), "OAuth state"),
        };
      }
    }
  }
  const callback = (state: string, query = "code=fixture-code") =>
    fetch(
      `http://127.0.0.1:${gateway.port}/oauth/provider/callback?state=${encodeURIComponent(state)}&${query}`,
    );
  async function terminal(sessionId: string, client = owner) {
    while (true) {
      const next = await rpcReq<WizardNextResult>(client, "wizard.next", { sessionId });
      expect(next.ok, JSON.stringify(next.error)).toBe(true);
      const result = expectDefined(next.payload, "wizard result");
      if (result.done) {
        return result;
      }
    }
  }

  return {
    get gateway() {
      return gateway;
    },
    get gatewayPort() {
      return gatewayPort;
    },
    get owner() {
      return owner;
    },
    get other() {
      return other;
    },
    get readOnly() {
      return readOnly;
    },
    get resourceUrl() {
      return resourceUrl;
    },
    get config() {
      return config;
    },
    get expectedChallenge() {
      return expectedChallenge;
    },
    set expectedChallenge(value: typeof expectedChallenge) {
      expectedChallenge = value;
    },
    get registeredRedirect() {
      return registeredRedirect;
    },
    set registeredRedirect(value: typeof registeredRedirect) {
      registeredRedirect = value;
    },
    get tokenError() {
      return tokenError;
    },
    set tokenError(value: typeof tokenError) {
      tokenError = value;
    },
    get issuerRequired() {
      return issuerRequired;
    },
    set issuerRequired(value: typeof issuerRequired) {
      issuerRequired = value;
    },
    get tokenEntered() {
      return tokenEntered;
    },
    set tokenEntered(value: typeof tokenEntered) {
      tokenEntered = value;
    },
    get releaseToken() {
      return releaseToken;
    },
    set releaseToken(value: typeof releaseToken) {
      releaseToken = value;
    },
    get redirectStage() {
      return redirectStage;
    },
    set redirectStage(value: typeof redirectStage) {
      redirectStage = value;
    },
    get redirectEntered() {
      return redirectEntered;
    },
    set redirectEntered(value: typeof redirectEntered) {
      redirectEntered = value;
    },
    get releaseRedirect() {
      return releaseRedirect;
    },
    set releaseRedirect(value: typeof releaseRedirect) {
      releaseRedirect = value;
    },
    get admitted() {
      return admitted;
    },
    set admitted(value: typeof admitted) {
      admitted = value;
    },
    get beforeLogin() {
      return beforeLogin;
    },
    set beforeLogin(value: typeof beforeLogin) {
      beforeLogin = value;
    },
    get admissionSettled() {
      return admissionSettled;
    },
    set admissionSettled(value: typeof admissionSettled) {
      admissionSettled = value;
    },
    get discoveryEntered() {
      return discoveryEntered;
    },
    set discoveryEntered(value: typeof discoveryEntered) {
      discoveryEntered = value;
    },
    get logoutRequest() {
      return logoutRequest;
    },
    set logoutRequest(value: typeof logoutRequest) {
      logoutRequest = value;
    },
    get logoutEntered() {
      return logoutEntered;
    },
    set logoutEntered(value: typeof logoutEntered) {
      logoutEntered = value;
    },
    get releaseDiscovery() {
      return releaseDiscovery;
    },
    set releaseDiscovery(value: typeof releaseDiscovery) {
      releaseDiscovery = value;
    },
    identity,
    store,
    login,
    configure,
    getInvocation,
    registryGetter,
    getSession,
    resolverRegistry,
    expectPendingCleared,
    expectSettled,
    resolvedTransport,
    connect,
    startLogin,
    begin,
    callback,
    terminal,
    requests,
    effects,
  };
}
