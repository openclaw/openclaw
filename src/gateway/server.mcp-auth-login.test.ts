import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type {
  WizardNextResult,
  WizardStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import { getOrCreateSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { partitionMcpServersByConnectionScope } from "../agents/mcp-connection-resolver.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import {
  cancelMcpOAuthAuthorization,
  clearMcpOAuthCredentials,
  recordMcpOAuthAuthorizationRequired,
  startMcpOAuthAuthorization,
} from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "../plugins/current-plugin-metadata-state.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as setupMigration from "../wizard/setup.migration-snapshot.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { mcpAuthLoginHandlers } from "./server-methods/mcp-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "./server-methods/setup-admission.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  registerMcpAuthForcedEffects,
  type McpAuthEffectEndpoint,
} from "./server.mcp-auth-login.forced-effects.test-support.js";
import { prepareTailscalePublishedOrigin } from "./tailscale-published-origin.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

describe("registered mcp.authLogin", () => {
  let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
  let owner: WebSocket;
  let other: WebSocket;
  let readOnly: WebSocket;
  let resourceUrl: string;
  let config: McpServerConfig;
  let expectedChallenge: string;
  let registeredRedirect: string;
  let tokenError: "invalid_grant" | "invalid_client" | false = false;
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
  let releaseDiscovery: Deferred | undefined;
  const requests: string[] = [];
  const endpoint = createServer((request, response) => {
    void (async () => {
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
        response.end(
          JSON.stringify({
            resource: resourceUrl,
            authorization_servers: [new URL(resourceUrl).origin],
          }),
        );
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        response.end(
          JSON.stringify({
            issuer: new URL(resourceUrl).origin,
            authorization_endpoint: "https://provider.example/authorize",
            token_endpoint: new URL("/token", resourceUrl).href,
            registration_endpoint: new URL("/register", resourceUrl).href,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          }),
        );
      } else if (url.pathname === "/register") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const metadata = JSON.parse(body);
        registeredRedirect = metadata.redirect_uris[0];
        response.end(JSON.stringify({ ...metadata, client_id: "fixture-client" }));
      } else if (url.pathname === "/token") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
        const params = new URLSearchParams(body);
        tokenEntered.resolve();
        if (releaseToken) {
          await releaseToken.promise;
        }
        if (tokenError) {
          response.writeHead(400).end(
            JSON.stringify({
              error: tokenError,
              error_description: "private exchange detail",
            }),
          );
        } else if (
          params.get("code") !== "fixture-code" ||
          params.get("redirect_uri") !== registeredRedirect ||
          createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url") !== expectedChallenge
        ) {
          response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        } else {
          response.end(
            JSON.stringify({
              access_token: "fixture-access",
              refresh_token: "fixture-refresh",
              token_type: "Bearer",
              expires_in: effects.tokenLifetimeSeconds,
            }),
          );
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
        let body = "";
        for await (const chunk of request) {
          body += chunk;
        }
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
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
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
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture listener unavailable");
    }
    resourceUrl = `http://127.0.0.1:${address.port}/mcp`;
    config = { url: resourceUrl, transport: "streamable-http", auth: "oauth" };
    await writeConfigFile({
      gateway: { reload: { mode: "off" } },
      mcp: { servers: { docs: config } },
    });
    gateway = await createGatewaySuiteHarness({
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
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
  });

  const identity = () => operatorMcpOAuthIdentity("docs", resourceUrl);
  async function connect(scopes: string[], origin = `http://127.0.0.1:${gateway.port}`) {
    const client = await gateway.openWs({ origin });
    await connectOk(client, {
      scopes,
      deviceIdentityPath: path.join(resolveStateDir(), `connector-${randomUUID()}.sqlite`),
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
  async function begin(client = owner) {
    const sessionId = randomUUID();
    const start = await rpcReq<WizardStartResult>(client, "mcp.authLogin", {
      sessionId,
      serverName: "docs",
    });
    expect(start, JSON.stringify(start.error)).toMatchObject({
      ok: true,
      payload: { sessionId, done: false, status: "running" },
    });
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

  registerMcpAuthForcedEffects({
    connection: () => ({ owner, resourceUrl, config }),
    request: () => admitted,
    identity,
    begin,
    callback,
    terminal,
    requests,
    effects,
  });

  it("rejects non-admin callers and injected authority selectors before discovery", async () => {
    const before = requests.length;
    expect(
      (await rpcReq(readOnly, "mcp.authLogin", { sessionId: randomUUID(), serverName: "docs" })).ok,
    ).toBe(false);
    for (const field of ["url", "identity", "storeKey", "redirectUrl", "secret", "agentId"]) {
      expect(
        (
          await rpcReq(owner, "mcp.authLogin", {
            sessionId: randomUUID(),
            serverName: "docs",
            [field]: "injected",
          })
        ).ok,
      ).toBe(false);
    }
    expect(requests).toHaveLength(before);
  });

  it("replaces a tokenless CLI registration for browser sign-in, then calls the MCP tool", async () => {
    await clearMcpOAuthCredentials(identity());
    const resolved = resolveMcpTransportConfig("docs", config);
    if (resolved?.kind !== "http") {
      throw new Error("Fixture transport unavailable");
    }
    const cliAttempt = await startMcpOAuthAuthorization(identity(), resolved, {});
    if (cliAttempt.status !== "redirect") {
      throw new Error("Expected CLI authorization to register its callback");
    }
    expect(registeredRedirect).toBe("http://127.0.0.1:8989/oauth/callback");
    await cancelMcpOAuthAuthorization(identity(), cliAttempt.state);

    const started = await begin();
    expect((await rpcReq(other, "wizard.cancel", { sessionId: started.sessionId })).ok).toBe(false);
    expect((await callback(started.state)).status).toBe(200);
    expect(await terminal(started.sessionId)).toMatchObject({ status: "done" });
    expect((await callback(started.state)).status).toBe(410);
    const stored = await readMcpOAuthStore(identity().storeKey);
    expect(stored.tokens?.access_token).toBe("fixture-access");
    expect(stored.tokensAuthorizationServerUrl).toBe(new URL(resourceUrl).origin);
    expect(stored.codeVerifier).toBeUndefined();
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: randomUUID(),
      sessionKey: "agent:main:connector-proof",
      workspaceDir: resolveStateDir(),
      cfg: { mcp: { servers: { docs: config } } },
    });
    try {
      expect(await runtime.callTool("docs", "echo", {})).toMatchObject({
        content: [{ type: "text", text: "Authenticated connector reply" }],
      });
    } finally {
      await runtime.dispose();
    }
    const before = requests.length;
    const sessionId = randomUUID();
    expect((await rpcReq(owner, "mcp.authLogin", { sessionId, serverName: "docs" })).ok).toBe(true);
    expect(await terminal(sessionId)).toMatchObject({ status: "done" });
    expect(requests).toHaveLength(before);
  });

  it("explains an unavailable browser callback without starting OAuth", async () => {
    const origin = "http://localhost:3000";
    let client: WebSocket | undefined;
    try {
      await writeConfigFile({
        gateway: { reload: { mode: "off" }, controlUi: { allowedOrigins: [origin] } },
        mcp: { servers: { docs: config } },
      });
      client = await connect(["operator.admin"], origin);
      const before = requests.length;
      const sessionId = randomUUID();
      expect((await rpcReq(client, "mcp.authLogin", { sessionId, serverName: "docs" })).ok).toBe(
        true,
      );
      expect(await terminal(sessionId, client)).toMatchObject({
        status: "error",
        error: expect.stringContaining("secure Gateway address"),
      });
      expect(requests).toHaveLength(before);
    } finally {
      client?.close();
      await writeConfigFile({
        gateway: { reload: { mode: "off" } },
        mcp: { servers: { docs: config } },
      });
    }
  });

  it.each(["unchanged", "disabled", "metadata replaced"] as const)(
    "keeps bundle-only sign-in bound to its installed owner: %s",
    async (change) => {
      await clearMcpOAuthCredentials(identity());
      const previousMetadata = getCurrentPluginMetadataSnapshotState();
      const rootDir = path.join(resolveStateDir(), "docs-bundle");
      const manifestPath = path.join(rootDir, ".codex-plugin", "plugin.json");
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(
        manifestPath,
        JSON.stringify({ name: "docs-bundle", mcpServers: { docs: config } }),
      );
      const metadata = () =>
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "docs-bundle",
              origin: "global",
              format: "bundle",
              bundleFormat: "codex",
              rootDir,
              manifestPath,
            },
          ],
        });
      const bundleConfig: OpenClawConfig = {
        gateway: { reload: { mode: "off" } },
        plugins: { enabled: true, entries: { "docs-bundle": { enabled: true } } },
      };
      let started: Awaited<ReturnType<typeof begin>> | undefined;
      try {
        setGatewayPluginMetadataSnapshot(metadata(), { config: bundleConfig });
        await writeConfigFile(bundleConfig);
        started = await begin();
        tokenEntered = createDeferredCore();
        releaseToken = createDeferredCore();
        expect((await callback(started.state)).status).toBe(200);
        await tokenEntered.promise;
        if (change === "disabled") {
          await writeConfigFile({
            ...bundleConfig,
            plugins: { ...bundleConfig.plugins, entries: { "docs-bundle": { enabled: false } } },
          });
        } else if (change === "metadata replaced") {
          setGatewayPluginMetadataSnapshot(metadata(), { config: bundleConfig });
        }
        releaseToken.resolve();
        expect(await terminal(started.sessionId)).toMatchObject({
          status: change === "unchanged" ? "done" : "error",
        });
        const stored = await readMcpOAuthStore(identity().storeKey);
        expect(stored.tokens?.access_token).toBe(
          change === "unchanged" ? "fixture-access" : undefined,
        );
        expect(stored.codeVerifier).toBeUndefined();
        expect(stored.lastAuthorizationUrl).toBeUndefined();
        expect((await callback(started.state)).status).toBe(410);
      } finally {
        releaseToken?.resolve();
        releaseToken = undefined;
        if (started) {
          const session = admitted?.context.wizardSessions.get(started.sessionId);
          if (session) {
            await rpcReq(owner, "wizard.cancel", { sessionId: started.sessionId });
            await whenAdmittedWizardSessionSettled(session);
          }
        }
        if (previousMetadata.owner === "gateway") {
          setGatewayPluginMetadataSnapshot(previousMetadata.snapshot);
        } else {
          setCurrentPluginMetadataSnapshot(previousMetadata.snapshot);
        }
        await writeConfigFile({
          gateway: { reload: { mode: "off" } },
          mcp: { servers: { docs: config } },
        });
      }
    },
  );

  it("does not cancel a newer CLI attempt or accept malformed and denied callbacks", async () => {
    await clearMcpOAuthCredentials(identity());
    const started = await begin();
    const pending = await readMcpOAuthStore(identity().storeKey);
    const requestCount = requests.length;
    let settled = false;
    try {
      for (const query of ["code=one&code=two", "code=%20"]) {
        expect((await callback(started.state, query)).status).toBe(400);
        expect(await readMcpOAuthStore(identity().storeKey)).toEqual(pending);
        expect(requests).toHaveLength(requestCount);
        expect(
          await rpcReq(owner, "wizard.status", { sessionId: started.sessionId }),
        ).toMatchObject({
          ok: true,
          payload: { status: "running" },
        });
      }
      const resolved = resolveMcpTransportConfig("docs", config);
      if (resolved?.kind !== "http") {
        throw new Error("Fixture transport unavailable");
      }
      const newer = await startMcpOAuthAuthorization(identity(), resolved, {});
      expect(newer.status).toBe("redirect");
      const before = await readMcpOAuthStore(identity().storeKey);
      expect((await callback(started.state, "error=access_denied")).status).toBe(400);
      const result = await terminal(started.sessionId);
      settled = true;
      expect(result).toMatchObject({ status: "error" });
      expect(await readMcpOAuthStore(identity().storeKey)).toEqual(before);
    } finally {
      if (!settled) {
        await rpcReq(owner, "wizard.cancel", { sessionId: started.sessionId });
        await terminal(started.sessionId);
      }
    }
  });

  it.each(["invalid_grant", "invalid_client"] as const)(
    "preserves existing tokens and registration after %s",
    async (error) => {
      await clearMcpOAuthCredentials(identity());
      const initial = await begin();
      expect((await callback(initial.state)).status).toBe(200);
      expect(await terminal(initial.sessionId)).toMatchObject({ status: "done" });
      const before = await readMcpOAuthStore(identity().storeKey);
      expect(
        await recordMcpOAuthAuthorizationRequired({
          identity: identity(),
          rejectedAccessToken: "fixture-access",
          scope: "expanded",
        }),
      ).toBe(true);
      const started = await begin();
      tokenError = error;
      const exchangeRequests = requests.length;
      try {
        expect((await callback(started.state)).status).toBe(200);
        const result = await terminal(started.sessionId);
        expect(result.status).toBe("error");
        expect(JSON.stringify(result)).not.toContain("private exchange detail");
        const after = await readMcpOAuthStore(identity().storeKey);
        expect(after.tokens).toEqual(before.tokens);
        expect(after.clientInformation).toEqual(before.clientInformation);
        expect(after.tokensAuthorizationServerUrl).toEqual(before.tokensAuthorizationServerUrl);
        expect(after.codeVerifier).toBeUndefined();
        expect(after.lastAuthorizationUrl).toBeUndefined();
        expect(requests.slice(exchangeRequests)).toEqual(["/token"]);
        const retainedClient = new McpClient({ name: "retained-credential", version: "1.0.0" });
        try {
          await retainedClient.connect(
            new StreamableHTTPClientTransport(new URL(resourceUrl), {
              requestInit: {
                headers: {
                  Authorization: `Bearer ${expectDefined(after.tokens, "retained tokens").access_token}`,
                },
              },
            }),
          );
          expect((await retainedClient.listTools()).tools).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
          );
          expect(await retainedClient.callTool({ name: "echo", arguments: {} })).toMatchObject({
            content: [{ type: "text", text: "Authenticated connector reply" }],
          });
        } finally {
          await retainedClient.close();
        }
      } finally {
        tokenError = false;
      }
    },
  );

  it("rejects a resolver replacement between dispatch and handler admission", async () => {
    await clearMcpOAuthCredentials(identity());
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const sessionId = randomUUID();
    const before = requests.length;
    beforeLogin = async () => {
      entered.resolve();
      await release.promise;
    };
    const start = rpcReq(owner, "mcp.authLogin", { sessionId, serverName: "docs" });
    await entered.promise;
    const invocation = expectDefined(admitted, "admitted request");
    const resolveRegistry = expectDefined(
      invocation.context.getGatewayMethodRegistry,
      "selected registry getter",
    );
    const registry = createEmptyPluginRegistry();
    registry.mcpServerConnectionResolvers.push({
      pluginId: "fixture-resolver",
      source: "mcp-auth-login-fixture",
      resolver: { serverName: "docs", resolve: async () => ({ url: resourceUrl }) },
    });
    const replacement = createGatewayMethodRegistry(resolveRegistry().descriptors(), registry);
    try {
      invocation.context.getGatewayMethodRegistry = () => replacement;
      release.resolve();
      expect((await start).ok).toBe(false);
      expect(requests).toHaveLength(before);
      expect((await readMcpOAuthStore(identity().storeKey)).tokens).toBeUndefined();
    } finally {
      beforeLogin = undefined;
      release.resolve();
      invocation.context.getGatewayMethodRegistry = resolveRegistry;
      const session = invocation.context.wizardSessions.get(sessionId);
      if (session) {
        session.close(new Error("Test cleanup"));
        await whenAdmittedWizardSessionSettled(session);
        invocation.context.purgeWizardSession(sessionId);
      }
    }
  });

  it("expires callbacks and cancels the exact published attempt", async () => {
    await clearMcpOAuthCredentials(identity());
    const started = await begin();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      expect((await callback(started.state)).status).toBe(410);
    } finally {
      clock.mockRestore();
    }
    expect(await terminal(started.sessionId)).toMatchObject({ status: "error" });
    expect((await readMcpOAuthStore(identity().storeKey)).codeVerifier).toBeUndefined();
    const next = await begin();
    const session = expectDefined(
      admitted?.context.wizardSessions.get(next.sessionId),
      "admitted login session",
    );
    expect(await rpcReq(owner, "wizard.cancel", { sessionId: next.sessionId })).toMatchObject({
      ok: true,
      payload: { status: "cancelled" },
    });
    expect((await callback(next.state)).status).toBe(410);
    await whenAdmittedWizardSessionSettled(session);
    expect((await readMcpOAuthStore(identity().storeKey)).codeVerifier).toBeUndefined();
  });

  it.each(["register", "token"] as const)(
    "does not follow a %s redirect after configuration authority is withdrawn",
    async (stage) => {
      await clearMcpOAuthCredentials(identity());
      redirectEntered = createDeferredCore();
      releaseRedirect = createDeferredCore();
      const sessionId = randomUUID();
      let activeSessionId = sessionId;
      try {
        if (stage === "register") {
          redirectStage = stage;
          expect((await rpcReq(owner, "mcp.authLogin", { sessionId, serverName: "docs" })).ok).toBe(
            true,
          );
        } else {
          const started = await begin();
          activeSessionId = started.sessionId;
          redirectStage = stage;
          expect((await callback(started.state)).status).toBe(200);
        }
        await redirectEntered.promise;
        await writeConfigFile({
          gateway: { reload: { mode: "off" } },
          mcp: { servers: { docs: { ...config, enabled: false } } },
        });
        const before = requests.length;
        releaseRedirect.resolve();
        expect(await terminal(activeSessionId)).toMatchObject({ status: "error" });
        expect(requests.slice(before)).not.toContain(`/${stage}-final`);
        expect((await readMcpOAuthStore(identity().storeKey)).tokens).toBeUndefined();
      } finally {
        releaseRedirect.resolve();
        redirectStage = undefined;
        releaseRedirect = undefined;
        await writeConfigFile({
          gateway: { reload: { mode: "off" } },
          mcp: { servers: { docs: config } },
        });
      }
    },
  );

  it.each(["admin scope", "plugin registry", "connector URL", "in-place connector URL"] as const)(
    "rejects token publication after its %s authority changes",
    async (change) => {
      await clearMcpOAuthCredentials(identity());
      const started = await begin();
      const invocation = expectDefined(admitted, "admitted request");
      const client = expectDefined(invocation.client, "admitted client");
      const scopes = client.connect.scopes;
      const resolveRegistry = expectDefined(
        invocation.context.getGatewayMethodRegistry,
        "selected registry getter",
      );
      const originalRegistry = resolveRegistry();
      const registry = createEmptyPluginRegistry();
      registry.mcpServerConnectionResolvers.push({
        pluginId: "fixture-resolver",
        source: "mcp-auth-login-fixture",
        resolver: { serverName: "docs", resolve: async () => ({ url: resourceUrl }) },
      });
      const replacement = createGatewayMethodRegistry(originalRegistry.descriptors(), registry);
      let changedServer: McpServerConfig | undefined;
      let originalUrl: string | undefined;
      tokenEntered = createDeferredCore();
      releaseToken = createDeferredCore();
      try {
        expect((await callback(started.state)).status).toBe(200);
        await tokenEntered.promise;
        if (change === "admin scope") {
          client.connect.scopes = ["operator.read"];
        } else if (change === "plugin registry") {
          invocation.context.getGatewayMethodRegistry = () => replacement;
          expect(
            withPluginRuntimeRegistryScope(
              registry,
              () =>
                partitionMcpServersByConnectionScope({ docs: config }).resolverRequesterServerNames,
            ),
          ).toEqual(["docs"]);
        } else if (change === "connector URL") {
          await writeConfigFile({
            gateway: { reload: { mode: "off" } },
            mcp: { servers: { docs: { ...config, url: resourceUrl + "/replacement" } } },
          });
          await rpcReq(owner, "wizard.status", { sessionId: started.sessionId });
        } else {
          changedServer = expectDefined(
            invocation.context.getRuntimeConfig().mcp?.servers?.docs,
            "published connector",
          );
          originalUrl = changedServer.url;
          changedServer.url = resourceUrl + "/replacement";
        }
        const session = expectDefined(
          invocation.context.wizardSessions.get(started.sessionId),
          "admitted wizard",
        );
        releaseToken.resolve();
        // rpcReq republishes disk config. Let the exchange inspect the edited
        // runtime object before a subsequent RPC replaces that publication.
        await whenAdmittedWizardSessionSettled(session);
        expect(session.getStatus()).toBe("error");
        expect((await readMcpOAuthStore(identity().storeKey)).tokens).toBeUndefined();
        if (change === "connector URL" || change === "in-place connector URL") {
          const result = await terminal(started.sessionId);
          expect(result.status).toBe("error");
          expect(JSON.stringify(result)).not.toContain("private exchange detail");
        }
      } finally {
        releaseToken.resolve();
        releaseToken = undefined;
        client.connect.scopes = scopes;
        invocation.context.getGatewayMethodRegistry = resolveRegistry;
        if (changedServer) {
          changedServer.url = originalUrl;
        }
        if (change === "connector URL" || change === "in-place connector URL") {
          tokenError = false;
          await writeConfigFile({
            gateway: { reload: { mode: "off" } },
            mcp: { servers: { docs: config } },
          });
        } else {
          await terminal(started.sessionId);
        }
      }
    },
  );

  it.each(["admission", "discovery", "exchange"] as const)(
    "settles sign-in when its socket closes during %s",
    async (stage) => {
      await clearMcpOAuthCredentials(identity());
      const client = await connect(["operator.admin"]);
      discoveryEntered = createDeferredCore();
      tokenEntered = createDeferredCore();
      const release = createDeferredCore();
      const entered = createDeferredCore();
      const original = setupMigration.withSetupMigrationTargetLock;
      const admission =
        stage === "admission"
          ? vi.spyOn(setupMigration, "withSetupMigrationTargetLock")
          : undefined;
      admission?.mockImplementationOnce(async (stateDir, run) => {
        entered.resolve();
        await release.promise;
        return await original(stateDir, run);
      });
      admissionSettled = createDeferredCore();
      const before = requests.length;
      let callbackState: string | undefined;
      const sessionId = randomUUID();
      try {
        if (stage === "admission") {
          client.send(
            JSON.stringify({
              type: "req",
              id: randomUUID(),
              method: "mcp.authLogin",
              params: { sessionId, serverName: "docs" },
            }),
          );
          await entered.promise;
        } else if (stage === "discovery") {
          releaseDiscovery = release;
          expect(
            (await rpcReq(client, "mcp.authLogin", { sessionId, serverName: "docs" })).ok,
          ).toBe(true);
          await discoveryEntered.promise;
        } else {
          const started = await begin(client);
          callbackState = started.state;
          releaseToken = release;
          expect((await callback(started.state)).status).toBe(200);
          await tokenEntered.promise;
        }
        const invocation = expectDefined(admitted, "admitted request");
        const session =
          stage === "admission"
            ? undefined
            : expectDefined(
                invocation.context.wizardSessions.get(String(invocation.params.sessionId)),
                "admitted wizard",
              );
        const signal = expectDefined(invocation.client?.connectionSignal, "connection lifetime");
        const closed = new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        client.close();
        await closed;
        release.resolve();
        if (session) {
          await whenAdmittedWizardSessionSettled(session);
          expect(session.getStatus()).toBe("error");
        } else {
          await admissionSettled.promise;
          expect(invocation.context.wizardSessions.has(sessionId)).toBe(false);
          expect(requests).toHaveLength(before);
        }
        const stored = await readMcpOAuthStore(identity().storeKey);
        expect(stored.tokens).toBeUndefined();
        if (session) {
          expect(stored.codeVerifier).toBeUndefined();
          expect(stored.lastAuthorizationUrl).toBeUndefined();
        }
        if (callbackState) {
          expect((await callback(callbackState)).status).toBe(410);
        }
      } finally {
        release.resolve();
        releaseDiscovery = undefined;
        releaseToken = undefined;
        client.close();
        admission?.mockRestore();
      }
    },
  );

  it("retires the registered callback when its managed origin is withdrawn", async () => {
    await clearMcpOAuthCredentials(identity());
    const origin = `https://127.0.0.1:${gateway.port}`;
    await writeConfigFile({
      gateway: { reload: { mode: "off" }, controlUi: { allowedOrigins: [origin] } },
      mcp: { servers: { docs: config } },
    });
    const withdraw = prepareTailscalePublishedOrigin({ origin, mode: "serve" });
    const client = await connect(["operator.admin"], origin);
    try {
      const started = await begin(client);
      const session = expectDefined(
        expectDefined(admitted, "admitted request").context.wizardSessions.get(started.sessionId),
        "admitted wizard",
      );
      withdraw();
      await whenAdmittedWizardSessionSettled(session);
      expect(session.getStatus()).toBe("error");
      expect((await callback(started.state)).status).toBe(410);
      expect((await readMcpOAuthStore(identity().storeKey)).tokens).toBeUndefined();
    } finally {
      withdraw();
      client.close();
      await writeConfigFile({
        gateway: { reload: { mode: "off" } },
        mcp: { servers: { docs: config } },
      });
    }
  });
});
