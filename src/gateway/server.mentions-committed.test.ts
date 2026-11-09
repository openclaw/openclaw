import { X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
type GatewayEventFrame = { event?: string; payload?: unknown };

/** Two signed-in Control UI operators (Alice sends, Bob receives) on one agent with a mock model. */
async function startMentionGateway(params: {
  label: string;
  cleanup: AsyncDisposableStack;
  handleProvider: (body: string, reply: (text: string) => void) => Promise<void> | void;
  agentIdentity?: { name: string };
}) {
  const { label, cleanup } = params;
  const state = await createOpenClawTestState({
    label,
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    prepareProfileCatalog: true,
  });
  cleanup.defer(() => state.cleanup());
  const aliceEmail = `alice@${label}.example.test`;
  const bobEmail = `bob@${label}.example.test`;
  const alice = ensureProfileForEmail(aliceEmail);
  const bob = ensureProfileForEmail(bobEmail);
  setDisplayName(alice.id, "Alice");
  setUserProfileRole(alice.id, "administrator");
  setDisplayName(bob.id, "Bob");
  setUserProfileRole(bob.id, "administrator");
  let providerCalls = 0;
  const provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readRequestText(request)
      .then(async (body) => {
        providerCalls += 1;
        const call = providerCalls;
        await params.handleProvider(body, (text) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: `reply-${call}`,
            responseId: `response-${call}`,
          }),
        );
      })
      .catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  cleanup.defer(() => closeProvider(provider));
  const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), label);
  const scopes: OperatorScope[] = ["operator.admin"];
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: [aliceEmail, bobEmail],
      allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes },
    },
    identityScopes: { [bobEmail]: scopes, [aliceEmail]: scopes },
  };
  const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
  const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
  const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
  const headers = (email: string) => ({
    "x-forwarded-user": email,
    "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.50",
  });
  const origin = "https://control.example.test";
  const bobEvents: Array<(event: GatewayEventFrame) => void> = [];
  const senderEvents: Array<(event: GatewayEventFrame) => void> = [];
  const gateway = await startGatewayWithClient({
    configPath: state.configPath,
    auth,
    secure: true,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers(bobEmail),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes,
    onEvent: (event) => bobEvents.forEach((listener) => listener(event)),
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
        ...(params.agentIdentity ? { entries: { main: { identity: params.agentIdentity } } } : {}),
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
            administrator: { agents: "*", scopes, sessions: { others: "write" } },
          },
        },
      },
    },
  });
  cleanup.defer(async () => {
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: `${label} cleanup` });
  });
  const sender = await connectGatewayClient({
    url: `wss://127.0.0.1:${gateway.port}`,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers(aliceEmail),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes,
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: state.path("sender-device", "client", "credentials.sqlite"),
    }),
    onEvent: (event) => senderEvents.forEach((listener) => listener(event)),
  });
  cleanup.defer(() => disconnectGatewayClient(sender));
  const inboxChanged = createDeferred();
  bobEvents.push((event) => {
    if (event.event === "mentions.changed") {
      inboxChanged.resolve();
    }
  });
  const created = await sender.request<{ key: string }>("sessions.create", { agentId: "main" });
  return {
    alice,
    bob,
    bobClient: gateway.client,
    sender,
    target: created.key,
    inboxChanged,
    onSenderEvent: (listener: (event: GatewayEventFrame) => void) => senderEvents.push(listener),
  };
}

it("delivers a committed human mention once through authenticated chat.send", async ({
  signal,
}) => {
  await using cleanup = new AsyncDisposableStack();
  const providerStarted = createDeferred();
  const releaseProvider = createDeferred();
  const committed = createDeferred<unknown>();
  const fixture = await startMentionGateway({
    label: "committed-mention",
    cleanup,
    handleProvider: async (_body, reply) => {
      providerStarted.resolve();
      await releaseProvider.promise;
      reply("Acknowledged.");
    },
  });
  const { alice, bob, bobClient, sender, target, inboxChanged } = fixture;
  fixture.onSenderEvent((event) => {
    const payload = asOptionalRecord(event.payload);
    const message = asOptionalRecord(payload?.message);
    if (event.event === "session.message" && message?.idempotencyKey === "mention-original:user") {
      committed.resolve(payload?.messageSeq);
    }
  });
  await sender.request("sessions.messages.subscribe", { key: target });
  cleanup.defer(() => releaseProvider.resolve());
  await sender.request("chat.send", {
    sessionKey: target,
    message: "Start this conversation.",
    idempotencyKey: "mention-seed",
  });
  await withinTest(providerStarted.promise, signal);
  const lookup = await sender.request<{ users: { profileId: string }[] }>("users.mentionable", {
    sessionKey: target,
    query: "Bob",
  });
  expect(lookup.users.map((profile) => profile.profileId)).toContain(bob.id);
  const request = {
    sessionKey: target,
    message: "@Bob Please review.",
    idempotencyKey: "mention-original",
    // Human-only followups commit without steering or dispatching another agent turn.
    queueMode: "followup",
    mentions: [{ profileId: bob.id, start: 0, end: 4 }],
  };
  const accepted = await sender.request<{ runId: string }>("chat.send", request);
  releaseProvider.resolve();
  // An early ACK is not a transcript commit; wait for the original message's identity.
  expect(await withinTest(committed.promise, signal)).toBeGreaterThan(0);
  await withinTest(inboxChanged.promise, signal);
  const inbox = await bobClient.request<{ items: unknown[] }>("mentions.list", {});
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({
    sessionKey: target,
    senderProfileId: alice.id,
    excerpt: request.message,
  });
  const replay = await sender.request<{ runId: string }>("chat.send", request);
  expect(replay.runId).toBe(accepted.runId);
  expect((await bobClient.request<{ items: unknown[] }>("mentions.list", {})).items).toEqual(
    inbox.items,
  );
});

it("records a message addressed to people without an agent turn", async ({ signal }) => {
  await using cleanup = new AsyncDisposableStack();
  // Session naming also calls the model; only agent turns carry the system prompt.
  const agentTurns: string[] = [];
  const firstTurnStarted = createDeferred();
  const releaseFirstTurn = createDeferred();
  const fixture = await startMentionGateway({
    label: "human-addressed-mention",
    cleanup,
    agentIdentity: { name: "Robo" },
    handleProvider: async (body, reply) => {
      if (!body.includes("Generate a concise session title")) {
        agentTurns.push(body);
        if (agentTurns.length === 1) {
          firstTurnStarted.resolve();
          await releaseFirstTurn.promise;
        }
      }
      reply("Acknowledged.");
    },
  });
  const { alice, bob, bobClient, sender, target, inboxChanged } = fixture;
  const terminals = new Map<string, ReturnType<typeof createDeferred<ChatTerminal>>>();
  const terminal = (runId: string) => {
    let deferred = terminals.get(runId);
    if (!deferred) {
      deferred = createDeferred<ChatTerminal>();
      terminals.set(runId, deferred);
    }
    return deferred;
  };
  fixture.onSenderEvent((event) => {
    const payload = asOptionalRecord(event.payload);
    const runId = payload?.runId;
    const chatState = payload?.state;
    if (
      event.event === "chat" &&
      typeof runId === "string" &&
      (chatState === "final" || chatState === "aborted" || chatState === "error")
    ) {
      terminal(runId).resolve({ state: chatState, message: asOptionalRecord(payload?.message) });
    }
  });
  cleanup.defer(() => releaseFirstTurn.resolve());
  const seed = await sender.request<{ runId: string }>("chat.send", {
    sessionKey: target,
    message: "Start this conversation.",
    idempotencyKey: "seed",
  });
  await withinTest(firstTurnStarted.promise, signal);

  // While the agent is still working, Alice talks to Bob. Interrupt mode would
  // normally abort the active run; a message to people leaves it alone.
  const toBob = await sender.request<{ runId: string }>("chat.send", {
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
  const inbox = await bobClient.request<{ items: unknown[] }>("mentions.list", {});
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({
    sessionKey: target,
    senderProfileId: alice.id,
    excerpt: "@Bob some of the stickers are cool",
  });
  expect(agentTurns).toHaveLength(1);

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
  expect(agentTurns).toHaveLength(1);

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
  expect(agentTurns).toHaveLength(2);
  expect(agentTurns[1]).toContain("put them on one sheet");
  expect(agentTurns[1]).toContain("stickers are cool");
});
