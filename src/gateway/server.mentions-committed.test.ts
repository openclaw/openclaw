import { X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { setDisplayName, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("delivers a committed human mention once through authenticated chat.send", async () => {
  const state = await createOpenClawTestState({
    label: "committed-mention",
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    prepareProfileCatalog: true,
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => state.cleanup());
  const alice = ensureProfileForEmail("alice@committed-mention.example.test");
  const bob = ensureProfileForEmail("bob@committed-mention.example.test");
  setDisplayName(alice.id, "Alice");
  setUserProfileRole(alice.id, "administrator");
  setDisplayName(bob.id, "Bob");
  setUserProfileRole(bob.id, "administrator");
  const provider = createServer((request, response) => {
    void readRequestText(request)
      .then(() => {
        writeOpenAiResponsesText(response, {
          text: "Acknowledged.",
          messageId: "mention-reply",
          responseId: "mention-response",
        });
      })
      .catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  cleanup.defer(() => closeProvider(provider));
  const model = buildMockOpenAiResponsesProvider(
    await listenProvider(provider),
    "committed-mention",
  );
  const scopes: OperatorScope[] = ["operator.admin"];
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: ["alice@committed-mention.example.test", "bob@committed-mention.example.test"],
      allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes },
    },
    identityScopes: {
      "bob@committed-mention.example.test": scopes,
      "alice@committed-mention.example.test": scopes,
    },
  };
  const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
  const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
  const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
  const headers = (email: string) => ({
    "x-forwarded-user": email,
    "x-forwarded-for": "203.0.113.50",
    "x-forwarded-proto": "https",
  });
  const origin = "https://control.example.test";
  const gateway = await startGatewayWithClient({
    configPath: state.configPath,
    auth,
    secure: true,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers("bob@committed-mention.example.test"),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: ["operator.admin"],
    cfg: {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      tools: { profile: "minimal" },
      gateway: {
        auth,
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: { allowedOrigins: [origin] },
        roles: {
          default: "administrator",
          definitions: {
            administrator: {
              agents: "*",
              scopes: ["operator.admin"],
              sessions: { others: "write" },
            },
          },
        },
      },
    },
  });
  cleanup.defer(async () => {
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "committed mention cleanup" });
  });
  const sender = await connectGatewayClient({
    url: `wss://127.0.0.1:${gateway.port}`,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers("alice@committed-mention.example.test"),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: ["operator.admin"],
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: state.path("sender-device", "client", "credentials.sqlite"),
    }),
  });
  cleanup.defer(() => disconnectGatewayClient(sender));
  const created = await sender.request<{ key: string }>("sessions.create", { agentId: "main" });
  const target = created.key;
  const seed = await sender.request<{ runId: string }>("chat.send", {
    sessionKey: target,
    message: "Start this conversation.",
    idempotencyKey: "mention-seed",
  });
  await gateway.client.request("agent.wait", { runId: seed.runId, timeoutMs: 30_000 });
  const lookup = await sender.request<{ users: { profileId: string }[] }>("users.mentionable", {
    sessionKey: target,
    query: "Bob",
  });
  expect(lookup.users.map((profile) => profile.profileId)).toContain(bob.id);
  const request = {
    sessionKey: target,
    message: "@Bob Please review.",
    idempotencyKey: "mention-original",
    mentions: [{ profileId: bob.id, start: 0, end: 4 }],
  };
  const accepted = await sender.request<{ runId: string; messageSeq: number }>(
    "chat.send",
    request,
  );
  expect(accepted.messageSeq).toBeGreaterThan(0);
  await gateway.client.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 });
  const inbox = await gateway.client.request<{ items: unknown[] }>("mentions.list", {});
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({
    sessionKey: target,
    senderProfileId: alice.id,
    excerpt: request.message,
  });
  const replay = await sender.request<{ runId: string }>("chat.send", request);
  expect(replay.runId).toBe(accepted.runId);
  expect((await gateway.client.request<{ items: unknown[] }>("mentions.list", {})).items).toEqual(
    inbox.items,
  );
});
