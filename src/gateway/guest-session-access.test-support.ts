import { X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
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

type GatewayEvent = { event?: string; payload?: unknown };

async function startInvitedGuestGateway(signal: AbortSignal, cleanup: AsyncDisposableStack) {
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
  cleanup.defer(() => state.cleanup());
  const alice = ensureProfileForEmail("alice@committed-mention.example.test");
  const bob = ensureProfileForEmail("bob@committed-mention.example.test");
  const carol = ensureProfileForEmail("carol@committed-mention.example.test");
  setDisplayName(alice.id, "Alice");
  setUserProfileRole(alice.id, "administrator");
  setDisplayName(bob.id, "Bob");
  setUserProfileRole(bob.id, "guest");
  setDisplayName(carol.id, "Carol");
  setUserProfileRole(carol.id, "invited");
  const events: Record<"guest" | "invited" | "sender", GatewayEvent[]> = {
    guest: [],
    invited: [],
    sender: [],
  };
  const providerRequests: string[] = [];
  const providerReplies: { beforeReply?: () => Promise<void> } = {};
  const provider = createServer((request, response) => {
    void readRequestText(request)
      .then(async (body) => {
        providerRequests.push(body);
        await providerReplies.beforeReply?.();
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
  const guestScopes: OperatorScope[] = ["operator.sessions.read", "operator.sessions.write"];
  const invitedScopes: OperatorScope[] = [
    "operator.read",
    "operator.write",
    "operator.questions",
    "operator.approvals",
  ];
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: [
        "alice@committed-mention.example.test",
        "bob@committed-mention.example.test",
        "carol@committed-mention.example.test",
      ],
      allowLoopback: true,
      deviceAutoApprove: { enabled: true, scopes: [...scopes, ...guestScopes, ...invitedScopes] },
    },
    identityScopes: {
      "bob@committed-mention.example.test": guestScopes,
      "carol@committed-mention.example.test": invitedScopes,
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
    scopes: guestScopes,
    onEvent: (event) => events.guest.push(event),
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
      tools: {
        profile: "minimal",
        alsoAllow: ["read", "sessions_history", "sessions_search"],
      },
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
            invited: {
              agents: ["main"],
              scopes: invitedScopes,
              sessions: { others: "invited" },
            },
            guest: {
              agents: ["main"],
              scopes: guestScopes,
              sessions: { others: "invited" },
            },
          },
        },
      },
    },
  });
  cleanup.defer(() => gateway.server.close({ reason: "committed mention cleanup" }));
  cleanup.defer(() => disconnectGatewayClient(gateway.client));
  const sender = await connectGatewayClient({
    signal,
    url: `wss://127.0.0.1:${gateway.port}`,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers("alice@committed-mention.example.test"),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: ["operator.admin"],
    caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
    onEvent: (event) => events.sender.push(event),
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: state.path("sender-device", "client", "credentials.sqlite"),
    }),
  });
  cleanup.defer(() => disconnectGatewayClient(sender));
  const invited = await connectGatewayClient({
    signal,
    url: `wss://127.0.0.1:${gateway.port}`,
    tlsFingerprint,
    origin,
    edgeAuthHeaders: headers("carol@committed-mention.example.test"),
    clientName: "openclaw-control-ui",
    mode: "webchat",
    scopes: invitedScopes,
    caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
    onEvent: (event) => events.invited.push(event),
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: state.path("invited-device", "client", "credentials.sqlite"),
    }),
  });
  cleanup.defer(() => disconnectGatewayClient(invited));
  return {
    state,
    gateway,
    sender,
    invited,
    alice,
    bob,
    carol,
    model,
    events,
    providerRequests,
    providerReplies,
    headers,
    tlsFingerprint,
    origin,
  };
}

export async function withInvitedGuestGateway(
  signal: AbortSignal,
  run: (fixture: Awaited<ReturnType<typeof startInvitedGuestGateway>>) => Promise<void>,
) {
  await using cleanup = new AsyncDisposableStack();
  await run(await startInvitedGuestGateway(signal, cleanup));
}
