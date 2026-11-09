import { X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
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

type ChatTerminal = { state: string; message?: Record<string, unknown> };

it("records a message addressed to people without an agent turn", async ({ signal }) => {
  const state = await createOpenClawTestState({
    label: "human-addressed-mention",
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
  const alice = ensureProfileForEmail("alice@human-addressed.example.test");
  const bob = ensureProfileForEmail("bob@human-addressed.example.test");
  setDisplayName(alice.id, "Alice");
  setUserProfileRole(alice.id, "administrator");
  setDisplayName(bob.id, "Bob");
  setUserProfileRole(bob.id, "administrator");
  // Session naming also calls the model; only agent turns carry the system prompt.
  const providerRequests: string[] = [];
  let providerCalls = 0;
  const firstTurnStarted = createDeferred();
  const releaseFirstTurn = createDeferred();
  const provider = createServer((request, response) => {
    void readRequestText(request)
      .then(async (body) => {
        providerCalls += 1;
        const agentTurn = !body.includes("Generate a concise session title");
        if (agentTurn) {
          providerRequests.push(body);
        }
        if (agentTurn && providerRequests.length === 1) {
          firstTurnStarted.resolve();
          await releaseFirstTurn.promise;
        }
        writeOpenAiResponsesText(response, {
          text: "Acknowledged.",
          messageId: `reply-${providerCalls}`,
          responseId: `response-${providerCalls}`,
        });
      })
      .catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  cleanup.defer(() => closeProvider(provider));
  const model = buildMockOpenAiResponsesProvider(
    await listenProvider(provider),
    "human-addressed-mention",
  );
  const scopes: OperatorScope[] = ["operator.admin"];
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: ["alice@human-addressed.example.test", "bob@human-addressed.example.test"],
      allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes },
    },
    identityScopes: {
      "bob@human-addressed.example.test": scopes,
      "alice@human-addressed.example.test": scopes,
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
  const inboxChanged = createDeferred();
  const gateway = await startGatewayWithClient({
    configPath: state.configPath,
    auth,
    secure: true,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers("bob@human-addressed.example.test"),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: ["operator.admin"],
    onEvent: (event) => {
      if (event.event === "mentions.changed") {
        inboxChanged.resolve();
      }
    },
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
        entries: { main: { identity: { name: "Robo" } } },
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
    await gateway.server.close({ reason: "human addressed mention cleanup" });
  });
  const terminals = new Map<string, ReturnType<typeof createDeferred<ChatTerminal>>>();
  const terminal = (runId: string) => {
    let deferred = terminals.get(runId);
    if (!deferred) {
      deferred = createDeferred<ChatTerminal>();
      terminals.set(runId, deferred);
    }
    return deferred;
  };
  const sender = await connectGatewayClient({
    url: `wss://127.0.0.1:${gateway.port}`,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers("alice@human-addressed.example.test"),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: ["operator.admin"],
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: state.path("sender-device", "client", "credentials.sqlite"),
    }),
    onEvent: (event) => {
      const payload = asOptionalRecord(event.payload);
      const runId = payload?.runId;
      const chatState = payload?.state;
      if (
        event.event === "chat" &&
        typeof runId === "string" &&
        (chatState === "final" || chatState === "aborted" || chatState === "error")
      ) {
        terminal(runId).resolve({
          state: chatState,
          message: asOptionalRecord(payload?.message),
        });
      }
    },
  });
  cleanup.defer(() => disconnectGatewayClient(sender));
  const created = await sender.request<{ key: string }>("sessions.create", { agentId: "main" });
  const target = created.key;
  cleanup.defer(() => releaseFirstTurn.resolve());
  const seed = await sender.request<{ runId: string }>("chat.send", {
    sessionKey: target,
    message: "Start this conversation.",
    idempotencyKey: "seed",
  });
  await withinTest(firstTurnStarted.promise, signal);

  // While the agent is still working, Alice talks to Bob. Interrupt mode would
  // normally abort the active run; a message to people leaves it alone.
  const toBob = await sender.request<{ runId: string; status: string }>("chat.send", {
    sessionKey: target,
    message: "@Bob some of the stickers are cool",
    idempotencyKey: "to-bob",
    queueMode: "interrupt",
    mentions: [{ profileId: bob.id, start: 0, end: 4 }],
  });
  const finished = await withinTest(terminal(toBob.runId).promise, signal);
  expect(finished.state).toBe("final");
  expect(finished.message).toBeUndefined();
  await withinTest(inboxChanged.promise, signal);
  const inbox = await gateway.client.request<{ items: unknown[] }>("mentions.list", {});
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({
    sessionKey: target,
    senderProfileId: alice.id,
    excerpt: "@Bob some of the stickers are cool",
  });
  expect(providerRequests).toHaveLength(1);

  releaseFirstTurn.resolve();
  expect(await withinTest(terminal(seed.runId).promise, signal)).toMatchObject({
    state: "final",
    message: { role: "assistant" },
  });
  const history = await sender.request<{ messages: Array<Record<string, unknown>> }>(
    "chat.history",
    { sessionKey: target },
  );
  const roles = history.messages.map((message) => message.role);
  expect(roles.filter((role) => role === "user")).toHaveLength(2);
  expect(roles.filter((role) => role === "assistant")).toHaveLength(1);
  expect(providerRequests).toHaveLength(1);

  const toBoth = await sender.request<{ runId: string }>("chat.send", {
    sessionKey: target,
    message: "@Bob look. Robo, put them on one sheet.",
    idempotencyKey: "to-both",
    mentions: [{ profileId: bob.id, start: 0, end: 4 }],
  });
  expect(await withinTest(terminal(toBoth.runId).promise, signal)).toMatchObject({
    state: "final",
    message: { role: "assistant" },
  });
  expect(providerRequests).toHaveLength(2);
  expect(providerRequests[1]).toContain("put them on one sheet");
  expect(providerRequests[1]).toContain("stickers are cool");
});
