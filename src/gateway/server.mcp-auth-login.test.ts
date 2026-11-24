import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { McpAuthLoginLinkResult } from "../../packages/gateway-protocol/src/index.js";
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
import { withMcpOAuthTestLease } from "../agents/mcp-oauth.test-support.js";
import { writeConfigFile } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "../plugins/current-plugin-metadata-state.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as setupMigration from "../wizard/setup.migration-snapshot.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import * as providerBrowserAuth from "./provider-browser-auth.js";
import { whenAdmittedWizardSessionSettled } from "./server-methods/setup-admission.js";
import { registerMcpAuthForcedEffects } from "./server.mcp-auth-login.forced-effects.test-support.js";
import { installMcpAuthLoginSuite } from "./server.mcp-auth-login.test-support.js";
import { rpcReq } from "./test-helpers.server.js";

describe("registered mcp.authLogin", () => {
  const suite = installMcpAuthLoginSuite();
  const {
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
  } = suite;
  let gatewayPort: typeof suite.gatewayPort;
  let owner: typeof suite.owner;
  let other: typeof suite.other;
  let readOnly: typeof suite.readOnly;
  let resourceUrl: typeof suite.resourceUrl;
  let config: typeof suite.config;
  beforeAll(() => {
    ({ gatewayPort, owner, other, readOnly, resourceUrl, config } = suite);
  });

  registerMcpAuthForcedEffects({
    connection: () => ({ resourceUrl, config }),
    request: () => suite.admitted,
    identity,
    begin,
    start: startLogin,
    callback,
    terminal,
    requests,
    effects,
  });

  it("rejects non-admin callers and injected authority selectors before discovery", async () => {
    const before = requests.length;
    expect((await login(readOnly)).ok).toBe(false);
    for (const field of ["url", "identity", "storeKey", "redirectUrl", "secret", "agentId"]) {
      expect((await login(owner, randomUUID(), { [field]: "injected" })).ok).toBe(false);
    }
    expect(requests).toHaveLength(before);
  });

  it("replaces a tokenless CLI registration for issuer-bound browser sign-in, then calls the MCP tool", async () => {
    suite.issuerRequired = true;
    await clearMcpOAuthCredentials(identity());
    const cliAttempt = await startMcpOAuthAuthorization(identity(), resolvedTransport(), {});
    if (cliAttempt.status !== "redirect") {
      throw new Error("Expected CLI authorization to register its callback");
    }
    expect(suite.registeredRedirect).toBe("http://127.0.0.1:8989/oauth/callback");
    await cancelMcpOAuthAuthorization(identity(), cliAttempt.state);

    const started = await begin();
    expect((await rpcReq(other, "wizard.cancel", { sessionId: started.sessionId })).ok).toBe(false);
    const query = `code=fixture-code&iss=${encodeURIComponent(new URL(resourceUrl).origin)}`;
    expect((await callback(started.state, query)).status).toBe(200);
    expect(await terminal(started.sessionId)).toMatchObject({ status: "done" });
    expect((await callback(started.state, query)).status).toBe(410);
    const stored = await store();
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
    expect((await login(owner, sessionId)).ok).toBe(true);
    expect(await terminal(sessionId)).toMatchObject({ status: "done" });
    expect(requests).toHaveLength(before);
  });

  it("explains an unavailable browser callback without starting OAuth", async () => {
    const origin = "http://localhost:3000";
    let client: WebSocket | undefined;
    try {
      await configure(config, origin);
      client = await connect(["operator.admin"], origin);
      const before = requests.length;
      const sessionId = randomUUID();
      expect((await login(client, sessionId)).ok).toBe(true);
      expect(await terminal(sessionId, client)).toMatchObject({
        status: "error",
        error: expect.stringContaining("HTTPS address"),
        reason: "secure_origin_unavailable",
      });
      expect(requests).toHaveLength(before);
    } finally {
      client?.close();
      await configure();
    }
  });

  it.each([undefined, "", "https://wrong.example/?code=private-callback-value"])(
    "rejects an unverified callback issuer %s without exchanging the code",
    async (iss) => {
      suite.issuerRequired = true;
      await clearMcpOAuthCredentials(identity());
      const started = await begin();
      const before = requests.length;
      const query = `code=fixture-code${iss === undefined ? "" : `&iss=${encodeURIComponent(iss)}`}`;
      expect((await callback(started.state, query)).status).toBe(200);
      const result = await terminal(started.sessionId);
      expect(result).toMatchObject({
        status: "error",
        error:
          "OpenClaw could not verify the sign-in provider. Close this dialog, review the connection settings, and try again.",
      });
      expect(JSON.stringify(result)).not.toMatch(
        /wrong\.example|private-callback-value|fixture-code/,
      );
      expect(requests.slice(before)).not.toContain("/token");
      const stored = await store();
      expect(stored.tokens).toBeUndefined();
      expectPendingCleared(stored);
    },
  );

  it.each(["registration", "network"] as const)(
    "explains %s failure without exposing provider-controlled details",
    async (failure) => {
      await clearMcpOAuthCredentials(identity());
      effects.endpoint = async (request, response) => {
        if (new URL(request.url ?? "/", resourceUrl).pathname !== "/register") {
          return false;
        }
        if (failure === "network") {
          request.socket.destroy();
        } else {
          response.writeHead(400).end(
            JSON.stringify({
              error: "invalid_client_metadata",
              error_description: "private-registration-detail https://private.example/?code=secret",
            }),
          );
        }
        return true;
      };
      try {
        const sessionId = await startLogin();
        const result = await terminal(sessionId);
        expect(result).toMatchObject({
          status: "error",
          error: expect.stringContaining(
            failure === "network"
              ? "could not reach the sign-in service"
              : "rejected this connection's settings",
          ),
        });
        expect(JSON.stringify(result)).not.toMatch(
          /private-registration-detail|private\.example|secret/,
        );
        expect((await store()).tokens).toBeUndefined();
      } finally {
        effects.endpoint = undefined;
      }
    },
  );

  it("reports an expired attempt rather than an explicit cancellation", async () => {
    await clearMcpOAuthCredentials(identity());
    const started = await begin();
    const handleCallback = providerBrowserAuth.handleProviderOAuthCallback;
    using callbackHandler = vi.spyOn(providerBrowserAuth, "handleProviderOAuthCallback");
    callbackHandler.mockImplementation((...args) => {
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(Date.now() + 10 * 60_000 + 1);
      return handleCallback(...args);
    });
    expect((await callback(started.state)).status).toBe(410);
    expect(await terminal(started.sessionId)).toMatchObject({
      status: "error",
      error: "Sign-in timed out.",
      reason: "timed_out",
    });
    expectPendingCleared(await store());
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
        suite.tokenEntered = createDeferredCore();
        suite.releaseToken = createDeferredCore();
        expect((await callback(started.state)).status).toBe(200);
        await suite.tokenEntered.promise;
        if (change === "disabled") {
          await writeConfigFile({
            ...bundleConfig,
            plugins: { ...bundleConfig.plugins, entries: { "docs-bundle": { enabled: false } } },
          });
        } else if (change === "metadata replaced") {
          setGatewayPluginMetadataSnapshot(metadata(), { config: bundleConfig });
        }
        suite.releaseToken.resolve();
        const result = await terminal(started.sessionId);
        expect(result.status).toBe(change === "unchanged" ? "done" : "error");
        if (change !== "unchanged") {
          expect(result.error).toBe(
            "Sign-in did not finish. Check the plugin settings, then select Connect to try again.",
          );
        }
        const stored = await store();
        expect(stored.tokens?.access_token).toBe(
          change === "unchanged" ? "fixture-access" : undefined,
        );
        expectPendingCleared(stored);
        expect((await callback(started.state)).status).toBe(410);
      } finally {
        suite.releaseToken?.resolve();
        suite.releaseToken = undefined;
        if (started) {
          const session = suite.admitted?.context.wizardSessions.get(started.sessionId);
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
        await configure();
      }
    },
  );

  it("signs a bundle-declared connector out without changing other connections", async () => {
    await clearMcpOAuthCredentials(identity());
    const previousMetadata = getCurrentPluginMetadataSnapshotState();
    const rootDir = path.join(resolveStateDir(), "docs-logout-bundle");
    const manifestPath = path.join(rootDir, ".codex-plugin", "plugin.json");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({ name: "docs-bundle", mcpServers: { docs: config } }),
    );
    const bundleConfig: OpenClawConfig = {
      gateway: { port: gatewayPort, reload: { mode: "off" } },
      plugins: { enabled: true, entries: { "docs-bundle": { enabled: true } } },
    };
    const unrelated = operatorMcpOAuthIdentity("other", resourceUrl);
    try {
      setGatewayPluginMetadataSnapshot(
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
        }),
        { config: bundleConfig },
      );
      await writeConfigFile(bundleConfig);
      const started = await rpcReq<McpAuthLoginLinkResult>(owner, "mcp.authLogin", {
        serverName: "docs",
      });
      expect(started.ok, JSON.stringify(started.error)).toBe(true);
      const link = expectDefined(started.payload, "plugin sign-in link");
      if (link.status !== "redirect") {
        throw new Error("Expected a plugin sign-in link");
      }
      const authorization = new URL(link.authorizationUrl);
      suite.expectedChallenge = expectDefined(
        authorization.searchParams.get("code_challenge"),
        "PKCE challenge",
      );
      const redirect = new URL(link.redirectUrl);
      redirect.searchParams.set(
        "state",
        expectDefined(authorization.searchParams.get("state"), "OAuth state"),
      );
      redirect.searchParams.set("code", "fixture-code");
      expect((await fetch(redirect)).status).toBe(200);
      expect((await store()).tokens?.access_token).toBe("fixture-access");
      const unrelatedAttempt = await startMcpOAuthAuthorization(unrelated, resolvedTransport(), {});
      if (unrelatedAttempt.status === "redirect") {
        await cancelMcpOAuthAuthorization(unrelated, unrelatedAttempt.state);
      }
      const unrelatedBefore = await readMcpOAuthStore(unrelated.storeKey);
      expect(unrelatedBefore.clientInformation).toBeDefined();

      expect((await rpcReq(readOnly, "mcp.authLogout", { serverName: "docs" })).ok).toBe(false);
      expect(
        (await rpcReq(owner, "mcp.authLogout", { serverName: "missing" })).error,
      ).toMatchObject({ message: expect.stringContaining("no operator sign-in to clear") });
      expect((await store()).tokens?.access_token).toBe("fixture-access");

      // An administrator who loses the scope while logout waits for the credential lease
      // must not clear the shared sign-in.
      const revoked = await connect(["operator.admin"]);
      const holding = createDeferredCore();
      const release = createDeferredCore();
      const holder = withMcpOAuthTestLease(identity().storeKey, async () => {
        holding.resolve();
        await release.promise;
      });
      try {
        await holding.promise;
        suite.logoutEntered = createDeferredCore();
        const pendingLogout = rpcReq(revoked, "mcp.authLogout", { serverName: "docs" });
        await suite.logoutEntered.promise;
        expectDefined(suite.logoutRequest?.client, "logout client").connect.scopes = [
          "operator.read",
        ];
        release.resolve();
        await holder;
        expect((await pendingLogout).ok).toBe(false);
      } finally {
        release.resolve();
        await holder.catch(() => {});
        suite.logoutEntered = undefined;
        revoked.close();
      }
      expect((await store()).tokens?.access_token).toBe("fixture-access");

      expect(await rpcReq(owner, "mcp.authLogout", { serverName: "docs" })).toMatchObject({
        ok: true,
        payload: { serverName: "docs" },
      });
      const stored = await store();
      expect([stored.tokens, stored.clientInformation]).toEqual([undefined, undefined]);
      expect(await readMcpOAuthStore(unrelated.storeKey)).toEqual(unrelatedBefore);
    } finally {
      await clearMcpOAuthCredentials(unrelated);
      if (previousMetadata.owner === "gateway") {
        setGatewayPluginMetadataSnapshot(previousMetadata.snapshot);
      } else {
        setCurrentPluginMetadataSnapshot(previousMetadata.snapshot);
      }
      await configure();
    }
  });

  it("does not cancel a newer CLI attempt when its browser sign-in is denied", async () => {
    await clearMcpOAuthCredentials(identity());
    const started = await begin();
    const pending = await store();
    const requestCount = requests.length;
    try {
      expect((await callback(started.state, "code=%20")).status).toBe(400);
      expect(await store()).toEqual(pending);
      expect(requests).toHaveLength(requestCount);
      expect(await rpcReq(owner, "wizard.status", { sessionId: started.sessionId })).toMatchObject({
        ok: true,
        payload: { status: "running" },
      });
      const newer = await startMcpOAuthAuthorization(identity(), resolvedTransport(), {});
      expect(newer.status).toBe("redirect");
      const before = await store();
      expect(
        (
          await callback(
            started.state,
            "error=access_denied&error_description=private-denial-detail&error_uri=https%3A%2F%2Fprivate.example",
          )
        ).status,
      ).toBe(400);
      // A denial keeps the attempt open so the user can go back and allow access.
      expect(await rpcReq(owner, "wizard.status", { sessionId: started.sessionId })).toMatchObject({
        ok: true,
        payload: { status: "running" },
      });
      expect(await store()).toEqual(before);
    } finally {
      await rpcReq(owner, "wizard.cancel", { sessionId: started.sessionId });
      await terminal(started.sessionId);
    }
  });

  it("preserves existing tokens and registration after invalid_client", async () => {
    await clearMcpOAuthCredentials(identity());
    const initial = await begin();
    expect((await callback(initial.state)).status).toBe(200);
    expect(await terminal(initial.sessionId)).toMatchObject({ status: "done" });
    const before = await store();
    expect(
      await recordMcpOAuthAuthorizationRequired({
        identity: identity(),
        rejectedAccessToken: "fixture-access",
        scope: "expanded",
      }),
    ).toBe(true);
    const started = await begin();
    suite.tokenError = "invalid_client";
    const exchangeRequests = requests.length;
    try {
      expect((await callback(started.state)).status).toBe(200);
      const result = await terminal(started.sessionId);
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "The sign-in service rejected this attempt. Existing credentials were not changed. Close this dialog, review the connection settings, and try again.",
      );
      expect(JSON.stringify(result)).not.toContain("private exchange detail");
      const after = await store();
      expect(after.tokens).toEqual(before.tokens);
      expect(after.clientInformation).toEqual(before.clientInformation);
      expect(after.tokensAuthorizationServerUrl).toEqual(before.tokensAuthorizationServerUrl);
      expectPendingCleared(after);
      expect(requests.slice(exchangeRequests)).toEqual(["/token"]);
      const retainedClient = new McpClient(
        { name: "retained-credential", version: "1.0.0" },
        { versionNegotiation: { mode: "legacy" } },
      );
      try {
        const Authorization = `Bearer ${expectDefined(after.tokens, "retained tokens").access_token}`;
        await retainedClient.connect(
          new StreamableHTTPClientTransport(new URL(resourceUrl), {
            requestInit: { headers: { Authorization } },
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
      suite.tokenError = false;
    }
  });

  it("rejects a resolver replacement between dispatch and handler admission", async () => {
    await clearMcpOAuthCredentials(identity());
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const sessionId = randomUUID();
    const before = requests.length;
    suite.beforeLogin = async () => {
      entered.resolve();
      await release.promise;
    };
    const start = login(owner, sessionId);
    await entered.promise;
    const invocation = getInvocation();
    const resolveRegistry = registryGetter();
    const registry = resolverRegistry();
    const replacement = createGatewayMethodRegistry(resolveRegistry().descriptors(), registry);
    try {
      invocation.context.getGatewayMethodRegistry = () => replacement;
      release.resolve();
      expect((await start).ok).toBe(false);
      expect(requests).toHaveLength(before);
      expect((await store()).tokens).toBeUndefined();
    } finally {
      suite.beforeLogin = undefined;
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

  it("cancels the exact published attempt", async () => {
    await clearMcpOAuthCredentials(identity());
    const next = await begin();
    const session = getSession(next.sessionId);
    expect(await rpcReq(owner, "wizard.cancel", { sessionId: next.sessionId })).toMatchObject({
      ok: true,
      payload: { status: "cancelled" },
    });
    expect((await callback(next.state)).status).toBe(410);
    await whenAdmittedWizardSessionSettled(session);
    expectPendingCleared(await store());
  });

  it.each(["register", "token"] as const)(
    "does not follow a %s redirect after configuration authority is withdrawn",
    async (stage) => {
      await clearMcpOAuthCredentials(identity());
      suite.redirectEntered = createDeferredCore();
      suite.releaseRedirect = createDeferredCore();
      const sessionId = randomUUID();
      let activeSessionId = sessionId;
      try {
        if (stage === "register") {
          suite.redirectStage = stage;
          expect((await login(owner, sessionId)).ok).toBe(true);
        } else {
          const started = await begin();
          activeSessionId = started.sessionId;
          suite.redirectStage = stage;
          expect((await callback(started.state)).status).toBe(200);
        }
        await suite.redirectEntered.promise;
        await configure({ ...config, enabled: false });
        const before = requests.length;
        suite.releaseRedirect.resolve();
        expect(await terminal(activeSessionId)).toMatchObject({ status: "error" });
        expect(requests.slice(before)).not.toContain(`/${stage}-final`);
        expect((await store()).tokens).toBeUndefined();
      } finally {
        suite.releaseRedirect.resolve();
        suite.redirectStage = undefined;
        suite.releaseRedirect = undefined;
        await configure();
      }
    },
  );

  it.each(["plugin registry", "connector URL", "in-place connector URL"] as const)(
    "rejects token publication after its %s changes",
    async (change) => {
      await clearMcpOAuthCredentials(identity());
      const started = await begin();
      const invocation = getInvocation();
      const resolveRegistry = registryGetter();
      const originalRegistry = resolveRegistry();
      const registry = resolverRegistry();
      const replacement = createGatewayMethodRegistry(originalRegistry.descriptors(), registry);
      let changedServer: McpServerConfig | undefined;
      let originalUrl: string | undefined;
      suite.tokenEntered = createDeferredCore();
      suite.releaseToken = createDeferredCore();
      try {
        expect((await callback(started.state)).status).toBe(200);
        await suite.tokenEntered.promise;
        if (change === "plugin registry") {
          invocation.context.getGatewayMethodRegistry = () => replacement;
          expect(
            withPluginRuntimeRegistryScope(
              registry,
              () =>
                partitionMcpServersByConnectionScope({ docs: config }).resolverRequesterServerNames,
            ),
          ).toEqual(["docs"]);
        } else if (change === "connector URL") {
          await configure({ ...config, url: resourceUrl + "/replacement" });
          await rpcReq(owner, "wizard.status", { sessionId: started.sessionId });
        } else {
          changedServer = expectDefined(
            invocation.context.getRuntimeConfig().mcp?.servers?.docs,
            "published connector",
          );
          originalUrl = changedServer.url;
          changedServer.url = resourceUrl + "/replacement";
        }
        const session = getSession(started.sessionId);
        suite.releaseToken.resolve();
        // rpcReq republishes disk config. Let the exchange inspect the edited
        // runtime object before a subsequent RPC replaces that publication.
        await expectSettled(session);
        expect((await store()).tokens).toBeUndefined();
        if (change === "connector URL" || change === "in-place connector URL") {
          const result = await terminal(started.sessionId);
          expect(result.status).toBe("error");
          expect(JSON.stringify(result)).not.toContain("private exchange detail");
        }
      } finally {
        suite.releaseToken.resolve();
        suite.releaseToken = undefined;
        invocation.context.getGatewayMethodRegistry = resolveRegistry;
        if (changedServer) {
          changedServer.url = originalUrl;
        }
        if (change === "connector URL" || change === "in-place connector URL") {
          suite.tokenError = false;
          await configure();
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
      suite.discoveryEntered = createDeferredCore();
      suite.tokenEntered = createDeferredCore();
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
      suite.admissionSettled = createDeferredCore();
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
          suite.releaseDiscovery = release;
          expect((await login(client, sessionId)).ok).toBe(true);
          await suite.discoveryEntered.promise;
        } else {
          const started = await begin(client);
          callbackState = started.state;
          suite.releaseToken = release;
          expect((await callback(started.state)).status).toBe(200);
          await suite.tokenEntered.promise;
        }
        const invocation = getInvocation();
        const session =
          stage === "admission" ? undefined : getSession(String(invocation.params.sessionId));
        const signal = expectDefined(invocation.client?.connectionSignal, "connection lifetime");
        const closed = new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        client.close();
        await closed;
        release.resolve();
        if (session) {
          await expectSettled(session);
        } else {
          await suite.admissionSettled.promise;
          expect(invocation.context.wizardSessions.has(sessionId)).toBe(false);
          expect(requests).toHaveLength(before);
        }
        const stored = await store();
        expect(stored.tokens).toBeUndefined();
        if (session) {
          expectPendingCleared(stored);
        }
        if (callbackState) {
          expect((await callback(callbackState)).status).toBe(410);
        }
      } finally {
        release.resolve();
        suite.releaseDiscovery = undefined;
        suite.releaseToken = undefined;
        client.close();
        admission?.mockRestore();
      }
    },
  );
});
