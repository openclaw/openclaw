import { randomUUID, X509Certificate } from "node:crypto";
// Real authenticated Gateway, agent/tool dispatch and persisted creator effects.
// Only provider HTTP is replayed; authorization and storage use production owners.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import * as sharingAuthority from "./server-methods/sessions-sharing-authority.js";
import { sessionSharingHandlers } from "./server-methods/sessions-sharing.js";
import { productModelConfig, productProvider } from "./server.chat-product.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
type Created = { key: string; sessionId: string };
type Receipt = { sessionKey: string; sessionId: string; runStarted: boolean };

it(
  "enforces causal creator final effects and revocation with default configuration",
  { timeout: 90_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "delegated-creator-product",
      env: {
        ...KERNEL_TEST_ENV,
        VITEST: process.env.VITEST,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        // The replay server is local; retain the ambient proxy for external traffic.
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
      },
      prepareProfileCatalog: true,
    });
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const people = Object.fromEntries(
      ["admin", "causal", "selected"].map((name) => [
        name,
        ensureProfileForEmail(name + "@creator.example.test"),
      ]),
    );
    setUserProfileRole(people.admin!.id, "administrator");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    cleanup.defer(() => release.resolve());
    const errors: unknown[] = [];
    let issued = false;
    let receipt: Receipt | undefined;
    const provider = productProvider(errors, async (text, response) => {
      const body = JSON.parse(text) as {
        input: Array<{ type?: string; role?: string; output?: string }>;
      };
      const title = JSON.stringify(
        body.input.filter((item) => item.role === "system" || item.role === "developer"),
      ).includes("Generate a concise session title");
      const output = body.input.find((item) => item.type === "function_call_output")?.output;
      if (output) {
        const parsed = JSON.parse(output) as Receipt;
        expect(parsed).toMatchObject({
          sessionKey: expect.any(String),
          sessionId: expect.any(String),
          runStarted: false,
        });
        receipt = parsed;
      }
      if (!title && !issued) {
        issued = true;
        entered.resolve();
        await release.promise;
        writeToolCall(response, "sessions_create", {
          label: "Causal creator proof",
          user: people.selected!.id,
        });
      } else {
        writeOpenAiResponsesText(response, {
          text: "Creator proof complete",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      }
    });
    cleanup.defer(() => closeProvider(provider));
    const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "creator-proof");
    const scopes: OperatorScope[] = ["operator.read", "operator.write"];
    const origin = "https://control.example.test";
    const auth: GatewayAuthConfig = {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: Object.keys(people).map((name) => name + "@creator.example.test"),
        allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes },
      },
      identityScopes: { "admin@creator.example.test": ["operator.admin"] },
    };
    const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
    const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
    const { defaults, models } = productModelConfig(state.workspaceDir, model);
    const cfg = {
      agents: { entries: { main: {} }, defaults },
      models,
      messages: { queue: { allowCollaborativeSteering: true } },
      plugins: { enabled: false, slots: { memory: "none" } },
      tools: { allow: ["sessions_create"], codeMode: { enabled: false }, toolSearch: false },
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1", "::1"],
        controlUi: { allowedOrigins: [origin] },
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
        roles: {
          default: "member",
          definitions: {
            administrator: {
              agents: "*",
              sessions: { others: "write" },
              scopes: ["operator.admin"],
            },
            member: { agents: "*", sessions: { others: "write" }, scopes },
            revoked: { agents: "*", sessions: { others: "none" }, scopes: ["operator.read"] },
          },
        },
      },
    } satisfies OpenClawConfig;
    const headers = (name: string) => ({
      "x-forwarded-user": name + "@creator.example.test",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.50",
    });
    const connection = {
      clientName: "openclaw-control-ui" as const,
      mode: "webchat" as const,
      origin,
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    };
    const gateway = await startGatewayWithClient({
      ...connection,
      cfg,
      configPath: state.configPath,
      auth,
      secure: true,
      scopes: ["operator.admin"],
      edgeAuthHeaders: headers("admin"),
    });
    cleanup.defer(async () => {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "creator proof complete" });
    });
    await gateway.server.startupSettled;
    const admin = gateway.client;
    async function connect(name: string) {
      const client = await connectGatewayClient({
        ...connection,
        url: `wss://127.0.0.1:${gateway.port}`,
        scopes,
        edgeAuthHeaders: headers(name),
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.statePath("identities", name, "client", "credentials.sqlite"),
        }),
      });
      cleanup.defer(() => disconnectGatewayClient(client));
      expect(await client.request("users.self", {})).toMatchObject({
        profile: { id: people[name]!.id },
      });
      return client;
    }
    const causal = await connect("causal");
    const selected = await connect("selected");
    const parent = await admin.request<Created>("sessions.create", {
      agentId: "main",
      label: "Creator proof parent",
    });
    expect(
      loadSessionEntryReadOnly({ agentId: "main", sessionKey: parent.key })?.createdActor,
    ).toEqual({ type: "human", source: "profile", id: people.admin!.id });
    const send = (client: Client, message: string, queueMode?: "steer") =>
      client.request<{ runId: string }>("chat.send", {
        sessionKey: parent.key,
        deliver: false,
        message,
        queueMode,
        idempotencyKey: randomUUID(),
      });
    const run = await send(causal, "Create a new idle task on my behalf.");
    const terminal = admin.request(
      "agent.wait",
      { runId: run.runId, timeoutMs: 60_000 },
      { timeoutMs: 65_000 },
    );
    await awaitGateBeforeSettlement(entered.promise, terminal, "model did not request creation");
    const steer = await send(
      selected,
      "Use my selected execution identity for this request.",
      "steer",
    );
    release.resolve();
    expect(await terminal).toMatchObject({ status: "ok" });
    expect(
      await admin.request("agent.wait", { runId: steer.runId, timeoutMs: 30_000 }),
    ).toMatchObject({ status: "ok" });
    expect(errors).toEqual([]);
    expect(receipt).toBeDefined();
    const child = receipt!;
    const entry = () => loadSessionEntryReadOnly({ agentId: "main", sessionKey: child.sessionKey });
    expect(entry()?.createdActor).toEqual({
      type: "human",
      source: "profile",
      id: people.selected!.id,
      delegatedBy: { type: "human", source: "profile", id: people.causal!.id },
    });
    const shareParams = { sessionKey: child.sessionKey, expectedSessionId: child.sessionId };
    const share = (client: Client, enabled: boolean) =>
      client.request("session.publicShare.set", { ...shareParams, enabled });
    const creator = causal;
    const creatorId = people.causal!.id;
    const before = structuredClone(entry());
    await expect(share(selected, true)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "session owner or operator.admin required",
    });
    expect(entry()).toEqual(before);
    const published = await share(creator, true);
    expect(published).toMatchObject({ ok: true, publicShare: { token: expect.any(String) } });
    expect(entry()?.publicShare).toBeDefined();
    await share(creator, false);
    expect(entry()?.publicShare).toBeUndefined();

    // Pause only after the real sharing owner has admitted this request. Revoke via
    // the real administration RPC, then let the unchanged handler reach its effect.
    const admitted = createDeferredCore();
    const resume = createDeferredCore();
    const settled = createDeferredCore();
    const prepare = sharingAuthority.prepareManagedSessionAccess;
    const handler = sessionSharingHandlers["session.publicShare.set"]!;
    const hold = vi
      .spyOn(sharingAuthority, "prepareManagedSessionAccess")
      .mockImplementation(async (params) => {
        const access = await prepare(params);
        if (params.sessionKey === child.sessionKey && access) {
          admitted.resolve();
          await resume.promise;
        }
        return access;
      });
    const observed = vi
      .spyOn(sessionSharingHandlers, "session.publicShare.set")
      .mockImplementation(async (options) => {
        try {
          await handler(options);
        } finally {
          settled.resolve();
        }
      });
    const beforeRevocation = structuredClone(entry());
    const denied = share(creator, true);
    void denied.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(
        admitted.promise,
        denied,
        "sharing mutation did not reach real admission",
      );
      await admin.request("users.setRole", { profileId: creatorId, role: "revoked" });
      resume.resolve();
      await expect(denied).rejects.toThrow();
      await settled.promise;
      expect(entry()).toEqual(beforeRevocation);
    } finally {
      resume.resolve();
      hold.mockRestore();
      observed.mockRestore();
    }
  },
);
