import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { Command } from "commander";
import { expect, it } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { registerModelsCli } from "../../cli/models-cli.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../../config/types.gateway.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import { connectUserModelAccountAsync } from "../../state/user-model-account-operations.js";
import { readUserModelAuthProfile } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import type { OperatorScope } from "../operator-scopes.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "../test-helpers.env.js";

const DOMAIN = "b1-cli-chat.example.test";
const ORIGIN = "https://b1-cli-chat.example.test";
const SESSION_KEY = "agent:main:b1-cli-chat";
const PROVIDER = "b1-chat-fixture";
const MODEL = "b1-chat-model";

const OWNER_EMAIL = `owner@${DOMAIN}`;

function forwardedHeaders() {
  return {
    "x-forwarded-user": OWNER_EMAIL,
    "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.50",
  };
}

// Exercise the registered CLI route, then observe the next real Gateway turn at
// a local synthetic provider endpoint.
it(
  "removes an owned model account and completes the next real Gateway chat turn",
  { timeout: 120_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "model-account-removal-cli-chat",
      env: {
        ...KERNEL_TEST_ENV,
        VITEST: process.env.VITEST,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
      prepareProfileCatalog: true,
    });
    const providerRequests: Array<{ model?: string; apiKey?: string }> = [];
    const endpoint = createServer((request, response) => {
      void (async () => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/messages");
        const requestBody = JSON.parse(await readText(request)) as { model?: string };
        providerRequests.push({
          model: requestBody.model,
          apiKey: request.headers["x-api-key"] as string | undefined,
        });
        const events = [
          {
            type: "message_start",
            message: {
              id: "b1-chat-message",
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 8, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "CHAT_AFTER_REMOVAL_OK" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let endpointClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
    let gatewayClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
    try {
      endpointClaim = await acquireTestPortBlock({ offsets: [0] });
      endpoint.listen(endpointClaim.port, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic model endpoint did not bind TCP");
      }
      const person = ensureProfileForEmail(OWNER_EMAIL);
      const connected = await connectUserModelAccountAsync({
        ownerProfileId: person.id,
        credential: {
          type: "token",
          provider: PROVIDER,
          token: "synthetic-b1-removal-account-token",
          displayName: "Synthetic removal account",
        },
        assertCurrent() {},
      });
      await replaceSessionEntry(
        {
          agentId: "main",
          storePath: resolveDefaultSessionStorePath("main"),
          sessionKey: SESSION_KEY,
        },
        {
          sessionId: "b1-cli-chat-session",
          updatedAt: 1,
          providerOverride: PROVIDER,
          modelOverride: MODEL,
          authProfileOverride: connected.authProfileId,
          authProfileOverrideSource: "user",
          modelFallback: {
            source: "agent-patch",
            ts: 1,
            prevModel: MODEL,
            prevProvider: PROVIDER,
            prevAuthProfileOverride: connected.authProfileId,
          },
        },
      );
      const scopes: OperatorScope[] = ["operator.read", "operator.write"];
      const auth: GatewayAuthConfig = {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: [OWNER_EMAIL],
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes },
        },
        identityScopes: {},
      };
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
      gatewayClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const cliUrl = `wss://127.0.0.1:${gatewayClaim.port}`;
      const cfg = {
        agents: {
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: `${PROVIDER}/${MODEL}`, fallbacks: [] },
            models: { [`${PROVIDER}/${MODEL}`]: { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            [PROVIDER]: {
              api: "anthropic-messages",
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiKey: "synthetic-b1-default-provider-key",
              models: [
                {
                  id: MODEL,
                  name: "Synthetic post-removal model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 128,
                },
              ],
            },
          },
        },
        plugins: { enabled: false, slots: { memory: "none" } },
        gateway: {
          mode: "local",
          auth,
          trustedProxies: ["127.0.0.1", "::1"],
          controlUi: { allowedOrigins: [ORIGIN] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          remote: {
            url: cliUrl,
            edgeAuth: forwardedHeaders(),
            tlsFingerprint: fingerprint,
          },
          roles: {
            default: "member",
            definitions: {
              member: { agents: "*", sessions: { others: "write" }, scopes },
            },
          },
        },
      };
      await state.writeConfig(cfg);
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        auth,
        secure: true,
        portClaim: gatewayClaim,
        tlsFingerprint: fingerprint,
        clientName: "openclaw-control-ui",
        mode: "webchat",
        origin: ORIGIN,
        scopes,
        edgeAuthHeaders: forwardedHeaders(),
      });
      gatewayClaim = undefined;
      await gateway.server.startupSettled;
      // CLI devices require explicit pairing; UI auto-approval is not a CLI bypass.
      const identity = loadOrCreateDeviceIdentity();
      const pairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        scopes,
      });
      await approveDevicePairing(pairing.request.requestId, {
        callerScopes: ["operator.admin"],
      });
      const cli = new Command();
      registerModelsCli(cli);
      await cli.parseAsync(
        ["models", "accounts", "remove", connected.authProfileId, "--yes", "--json"],
        { from: "user" },
      );
      const afterRemoval = loadSessionEntryReadOnly({
        agentId: "main",
        storePath: resolveDefaultSessionStorePath("main"),
        sessionKey: SESSION_KEY,
      });
      expect(afterRemoval?.authProfileOverride).toBeUndefined();
      expect(afterRemoval?.modelFallback?.prevAuthProfileOverride).toBeUndefined();
      expect(readUserModelAuthProfile(connected.authProfileId)).toBeUndefined();
      console.log(
        "[b1-cli-chat] registered CLI removed credential; current and rollback pins cleared",
      );

      const started = await gateway.client.request<{ runId: string; status: string }>("chat.send", {
        sessionKey: SESSION_KEY,
        message: "Reply with the fixture confirmation.",
        idempotencyKey: "b1-chat-after-removal",
        deliver: false,
      });
      expect(started.status).toBe("started");
      await expect(
        gateway.client.request("agent.wait", { runId: started.runId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      const history = await gateway.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: SESSION_KEY,
        limit: 20,
      });
      const assistant = (history.messages ?? []).findLast(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          (message as { role?: unknown }).role === "assistant",
      ) as { content?: unknown; model?: unknown; provider?: unknown } | undefined;
      expect(assistant).toMatchObject({ model: MODEL, provider: PROVIDER });
      expect(JSON.stringify(assistant?.content)).toContain("CHAT_AFTER_REMOVAL_OK");
      expect(providerRequests.map(({ model }) => model)).toEqual([MODEL]);
      expect(providerRequests.map(({ apiKey }) => apiKey)).toEqual([
        "synthetic-b1-default-provider-key",
      ]);
      console.log(
        "[b1-cli-chat] next Gateway chat completed; synthetic default selected; assistant confirmation present in history",
      );
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "B1 removal to chat proof complete" });
      }
      if (endpoint.listening) {
        endpoint.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          endpoint.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await endpointClaim?.release();
      await gatewayClaim?.release();
      await state.cleanup();
    }
  },
);
