import { createHash, randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { afterEach, expect, it, onTestFailed } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { requesterMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthCredentialsStatus } from "../agents/mcp-oauth.js";
import { seedMcpOAuthStoreForTest } from "../agents/mcp-oauth.test-support.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { createGatewayConfigPath, setupGatewayTempHome } from "./gateway.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const MODEL = "requester-proof/model";
const SERVER = "accounts";
const TLS_FINGERPRINT = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
});

/** The browser's return to the Gateway, through the trusted proxy that names its client. */
async function openGatewayCallback(url: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    // The fixture certificate is pinned by fingerprint, as the Gateway clients pin it.
    const request = https.get(
      url,
      { headers: { "x-forwarded-for": "203.0.113.99" }, rejectUnauthorized: false },
      (response) => {
        response.resume();
        if (
          (response.socket as TLSSocket).getPeerCertificate().fingerprint256 !== TLS_FINGERPRINT
        ) {
          reject(new Error("unexpected Gateway certificate"));
          return;
        }
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** A standard MCP OAuth server whose one tool names the account behind the bearer token. */
async function startAccountsServer() {
  let issuer = "";
  let consentingAccount: string | undefined;
  const codes = new Map<string, { account: string; challenge: string }>();
  const toolCallAccounts: string[] = [];
  let registrations = 0;
  let heldDiscovery: { entered: () => void; release: Promise<void> } | undefined;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return sendJson(response, { resource: `${issuer}/mcp`, authorization_servers: [issuer] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      if (heldDiscovery) {
        const hold = heldDiscovery;
        heldDiscovery = undefined;
        hold.entered();
        await hold.release;
      }
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
      registrations += 1;
      const metadata = JSON.parse(await readProviderBody(request)) as Record<string, unknown>;
      return sendJson(response, { ...metadata, client_id: `client-${randomUUID()}` }, 201);
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (!redirectUri || !state || !challenge || !consentingAccount) {
        return sendJson(response, { error: "invalid_request" }, 400);
      }
      const code = randomUUID();
      codes.set(code, { account: consentingAccount, challenge });
      consentingAccount = undefined;
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      return response.writeHead(302, { Location: callback.href }).end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await readProviderBody(request));
      const code = form.get("code") ?? "";
      const grant = codes.get(code);
      const verifier = form.get("code_verifier") ?? "";
      if (!grant || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
        return sendJson(response, { error: "invalid_grant" }, 400);
      }
      codes.delete(code);
      return sendJson(response, {
        access_token: `token-${grant.account}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        return response.writeHead(405).end();
      }
      const account = /^Bearer token-(.+)$/u.exec(request.headers.authorization ?? "")?.[1];
      if (!account) {
        return response
          .writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
      }
      const message = JSON.parse(await readProviderBody(request)) as {
        id?: number;
        method?: string;
      };
      const reply = (result: unknown) =>
        sendJson(response, { jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") {
        return reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER, version: "1.0.0" },
        });
      }
      if (message.method === "notifications/initialized") {
        return response.writeHead(202, { "Content-Length": "0" }).end();
      }
      if (message.method === "tools/list") {
        return reply({
          tools: [
            {
              name: "whoami",
              description: "Name the signed-in account.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      }
      if (message.method === "tools/call") {
        toolCallAccounts.push(account);
        return reply({ content: [{ type: "text", text: `signed in as ${account}` }] });
      }
      return sendJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      });
    }
    response.writeHead(404).end();
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("accounts fixture failed"));
    });
  });
  issuer = (await listenProvider(server)).replace(/\/v1$/u, "");
  return {
    url: `${issuer}/mcp`,
    toolCallAccounts,
    registrations: () => registrations,
    /** Holds the next sign-in's authorization server discovery until released. */
    holdNextDiscovery() {
      const entered = createDeferred();
      const release = createDeferred();
      heldDiscovery = { entered: () => entered.resolve(), release: release.promise };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    /** The provider's consent page for one account, then the browser's redirect to the Gateway. */
    async consent(authorizationUrl: string, account: string, gatewayOrigin: string) {
      consentingAccount = account;
      const authorize = await fetch(authorizationUrl, { redirect: "manual" });
      expect(authorize.status).toBe(302);
      const callback = authorize.headers.get("location") ?? "";
      expect(callback.startsWith(`${gatewayOrigin}/oauth/mcp/callback?`)).toBe(true);
      expect(await openGatewayCallback(callback)).toBe(200);
    },
    close: () => closeProvider(server),
  };
}

/** Calls the account tool when it is offered, else its sign-in tool, then reports the result. */
async function startModel() {
  let held: { entered: () => void; release: Promise<void> } | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readProviderBody(request)) as {
        input?: Array<{ type?: string; output?: unknown }>;
        tools?: Array<{ name?: string }>;
      };
      const last = body.input?.at(-1);
      const text = (value: string) =>
        writeOpenAiResponsesText(response, {
          text: value,
          messageId: `msg_${randomUUID()}`,
          responseId: `resp_${randomUUID()}`,
        });
      if (last?.type === "function_call_output") {
        text(
          `tool said: ${typeof last.output === "string" ? last.output : JSON.stringify(last.output)}`,
        );
        return;
      }
      const tools = new Set(body.tools?.map((tool) => tool.name));
      if (held) {
        // The turn's tools, credentials included, are ready before the model answers.
        const hold = held;
        held = undefined;
        hold.entered();
        await hold.release;
      }
      if (tools.has(`${SERVER}__whoami`)) {
        writeToolCall(response, `${SERVER}__whoami`, {});
      } else if (tools.has(`${SERVER}__connect`)) {
        writeToolCall(response, `${SERVER}__connect`, {});
      } else {
        text(`no ${SERVER} tools`);
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  const baseUrl = await listenProvider(server);
  return {
    baseUrl,
    /** Holds the next turn's first answer until released. */
    holdNextTurn() {
      const entered = createDeferred();
      const release = createDeferred();
      held = { entered: () => entered.resolve(), release: release.promise };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    close: () => closeProvider(server),
  };
}

async function ask(client: GatewayClient, sessionKey: string, message: string) {
  const runId = randomUUID();
  await client.request("chat.send", { sessionKey, message, idempotencyKey: runId });
  const done = await client.request<{ status?: string; terminalReply?: { text?: string } }>(
    "agent.wait",
    { runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(done.status).toBe("ok");
  return done.terminalReply?.text ?? "";
}

function signInLink(reply: string): string {
  const link = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s"\\]+)/u.exec(reply)?.[1];
  expect(link, reply).toBeDefined();
  return link!;
}

/** Everything but the Gateway's own section: one agent, the accounts server, the scripted model. */
function proofConfig(params: {
  workspaceDir: string;
  accountsUrl: string;
  modelBaseUrl: string;
  gateway: NonNullable<OpenClawConfig["gateway"]>;
}) {
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: params.workspaceDir,
        skipBootstrap: true,
        skills: [],
        model: { primary: MODEL },
        models: { [MODEL]: {} },
      },
      entries: { main: {} },
    },
    gateway: params.gateway,
    hooks: { enabled: false },
    mcp: {
      servers: {
        [SERVER]: {
          url: params.accountsUrl,
          transport: "streamable-http",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        "requester-proof": {
          baseUrl: params.modelBaseUrl,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "model",
              name: "model",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
    plugins: { slots: { memory: "none" } },
    tools: { profile: "full", codeMode: false, toolSearch: false },
  } satisfies OpenClawConfig;
}

async function startProof() {
  const accounts = await startAccountsServer();
  cleanups.push(accounts.close);
  const model = await startModel();
  cleanups.push(model.close);
  const { tempHome, workspaceDir, envSnapshot } = await setupGatewayTempHome({
    prefix: "openclaw-requester-mcp-",
  });
  cleanups.push(async () => {
    envSnapshot.restore();
    await fs.rm(tempHome, { recursive: true, force: true });
  });
  // The row a backend client's own identity holds, as a sign-in from before this change.
  const shared = requesterMcpOAuthIdentity(SERVER, accounts.url, {
    requesterSenderId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    messageChannel: "webchat",
  });
  seedMcpOAuthStoreForTest(shared.storeKey, {
    tokens: { access_token: "token-shared-account", token_type: "Bearer" },
  });
  return { accounts, model, tempHome, workspaceDir, shared };
}

it(
  "signs each verified person in separately through one backend client",
  { timeout: 120_000 },
  async () => {
    const { accounts, model, tempHome, workspaceDir, shared } = await startProof();
    let phase = "starting Gateway";
    onTestFailed(() => {
      process.stderr.write(`requester MCP proof failed while ${phase}\n`);
    });
    const port = await getFreePort();
    const gatewayOrigin = `https://127.0.0.1:${port}`;
    const certPath = path.join(tempHome, "cert.pem");
    const keyPath = path.join(tempHome, "key.pem");
    await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
    await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
    const cfg = proofConfig({
      workspaceDir,
      accountsUrl: accounts.url,
      modelBaseUrl: model.baseUrl,
      gateway: {
        publicOrigin: gatewayOrigin,
        trustedProxies: ["127.0.0.1"],
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-forwarded-user",
            allowLoopback: true,
            deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
          },
        },
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        controlUi: { allowedOrigins: ["https://control.example.test"] },
        roles: {
          default: "member",
          definitions: {
            member: {
              agents: "*",
              sessions: { others: "none" },
              scopes: ["operator.read", "operator.write"],
            },
            watcher: {
              agents: "*",
              sessions: { others: "view" },
              scopes: ["operator.read", "operator.write"],
            },
            denied: { agents: "*", sessions: { others: "none" }, scopes: [] },
          },
        },
      },
    });
    const proxied = (email: string) => ({
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-user": email,
    });
    // The dashboard user watches every run; Alice and Bob keep the member default.
    setUserProfileRole(ensureProfileForEmail("owner@example.test").id, "watcher");
    const aliceProfileId = ensureProfileForEmail("alice@example.test").id;
    // The Gateway's owner opens its dashboard; trusted-proxy auth approves browser devices.
    const gateway = await startGatewayWithClient({
      cfg,
      configPath: await createGatewayConfigPath(tempHome),
      auth: cfg.gateway.auth,
      port,
      secure: true,
      tlsFingerprint: TLS_FINGERPRINT,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: "https://control.example.test",
      edgeAuthHeaders: proxied("owner@example.test"),
      scopes: ["operator.read", "operator.write"],
    });
    cleanups.push(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "requester MCP proof complete" });
    });
    // One paired backend device brings both people in, each under their own verified identity.
    const device = loadOrCreateDeviceIdentity({ identityKey: "requester-proof-backend" });
    const pairing = await requestDevicePairing({
      deviceId: device.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(device.publicKeyPem),
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: GATEWAY_CLIENT_MODES.BACKEND,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
    await approveDevicePairing(pairing.request.requestId, {
      callerScopes: ["operator.read", "operator.write"],
    });
    const asPerson = async (email: string) => {
      const client = await connectGatewayClient({
        url: `wss://127.0.0.1:${port}`,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        deviceIdentity: device,
        scopes: ["operator.read", "operator.write"],
        tlsFingerprint: TLS_FINGERPRINT,
        edgeAuthHeaders: proxied(email),
      });
      cleanups.push(() => disconnectGatewayClient(client));
      return client;
    };
    const alice = await asPerson("alice@example.test");
    const bob = await asPerson("bob@example.test");
    const session = async (client: GatewayClient) =>
      (await client.request<{ key: string }>("sessions.create", { agentId: "main" })).key;
    const aliceSession = await session(alice);
    const bobSession = await session(bob);

    phase = "asking before sign-in";
    const aliceLink = signInLink(await ask(alice, aliceSession, "Which account am I using?"));
    signInLink(await ask(bob, bobSession, "Which account am I using?"));

    // Bob's sign-in started later; a shared requester would have replaced Alice's pending one.
    phase = "signing Alice in";
    await accounts.consent(aliceLink, "alice-account", gatewayOrigin);
    expect(await ask(alice, aliceSession, "Which account am I using?")).toContain(
      "signed in as alice-account",
    );
    // Alice's sign-in serves only Alice: Bob is still asked to connect his own account.
    const bobRetry = await ask(bob, bobSession, "Which account am I using?");
    expect(bobRetry).not.toContain("alice-account");
    expect(accounts.toolCallAccounts).toEqual(["alice-account"]);

    phase = "signing Bob in";
    await accounts.consent(signInLink(bobRetry), "bob-account", gatewayOrigin);
    expect(await ask(bob, bobSession, "Which account am I using?")).toContain(
      "signed in as bob-account",
    );
    expect(accounts.toolCallAccounts).toEqual(["alice-account", "bob-account"]);

    // Alice loses access mid-turn, after her tools were prepared and before the model calls one.
    phase = "revoking Alice during her turn";
    const held = model.holdNextTurn();
    const heldRun = randomUUID();
    await alice.request("chat.send", {
      sessionKey: aliceSession,
      message: "Which account am I using now?",
      idempotencyKey: heldRun,
    });
    await held.entered;
    setUserProfileRole(aliceProfileId, "denied");
    held.release();
    const settled = await gateway.client.request<{
      status?: string;
      terminalReply?: { text?: string };
    }>("agent.wait", { runId: heldRun, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
    // The revoked turn ends without its prepared account tool reaching the server.
    expect(settled.status).not.toBe("ok");
    expect(settled.terminalReply?.text ?? "").not.toContain("alice-account");
    expect(accounts.toolCallAccounts).toEqual(["alice-account", "bob-account"]);

    // Carol loses access while her sign-in already waits on the provider: it registers no client and leaves no
    // pending sign-in behind.
    phase = "revoking Carol during her sign-in";
    const carolProfileId = ensureProfileForEmail("carol@example.test").id;
    const carol = await asPerson("carol@example.test");
    const carolSession = await session(carol);
    const discovery = accounts.holdNextDiscovery();
    const registrationsBefore = accounts.registrations();
    const carolRun = randomUUID();
    await carol.request("chat.send", {
      sessionKey: carolSession,
      message: "Which account am I using?",
      idempotencyKey: carolRun,
    });
    await discovery.entered;
    setUserProfileRole(carolProfileId, "denied");
    discovery.release();
    const carolSettled = await gateway.client.request<{
      status?: string;
      terminalReply?: { text?: string };
    }>("agent.wait", { runId: carolRun, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
    expect(carolSettled.terminalReply?.text ?? "").not.toMatch(/\/authorize\?/u);
    expect(accounts.registrations()).toBe(registrationsBefore);
    await expect(
      readMcpOAuthCredentialsStatus(
        requesterMcpOAuthIdentity(SERVER, accounts.url, {
          requesterSenderId: carolProfileId,
          messageChannel: "webchat",
        }),
      ),
    ).resolves.toEqual({ state: "unauthenticated" });

    // Verified people neither used nor replaced the backend client's own sign-in.
    await expect(readMcpOAuthCredentialsStatus(shared)).resolves.toEqual({ state: "authorized" });
  },
);

it(
  "keeps a shared-token backend client on the sign-in its own identity holds",
  { timeout: 60_000 },
  async () => {
    const { accounts, model, tempHome, workspaceDir } = await startProof();
    const token = `requester-proof-${randomUUID()}`;
    const gateway = await startGatewayWithClient({
      cfg: proofConfig({
        workspaceDir,
        accountsUrl: accounts.url,
        modelBaseUrl: model.baseUrl,
        gateway: { auth: { mode: "token", token } },
      }),
      configPath: await createGatewayConfigPath(tempHome),
      token,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.read", "operator.write"],
    });
    cleanups.push(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "shared requester proof complete" });
    });
    const session = (
      await gateway.client.request<{ key: string }>("sessions.create", { agentId: "main" })
    ).key;
    // A shared token names no person, so the turn keeps the client's own requester identity.
    expect(await ask(gateway.client, session, "Which account am I using?")).toContain(
      "signed in as shared-account",
    );
    expect(accounts.toolCallAccounts).toEqual(["shared-account"]);
  },
);
