// Real TLS Gateway, profile editor RPCs, session creation, and agent provider I/O.
import "../agents/prepared-model-runtime.js";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { UsersPersonalFileGetResult } from "../../packages/gateway-protocol/src/index.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import { pairOperatorDeviceFixture } from "./paired-device.test-support.js";
import { startGatewayServerCore } from "./server-start.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "delivers saved and updated personal instructions to worktree agent requests",
  { timeout: 120_000 },
  async ({ signal }) => {
    const state = await createProductState("worktree-personal-instructions");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => state.cleanup());
    const requests: string[] = [];
    const errors: unknown[] = [];
    const provider = productProvider(errors, (body, response) => {
      requests.push(body);
      writeOpenAiResponsesText(response, {
        text: "PROFILE_FLOW_COMPLETED",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    });
    cleanup.defer(() => closeProvider(provider));
    const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "profile-proof");
    const { defaults, models } = productModelConfig(state.workspaceDir, model);
    const task = state.path("task");
    await fs.mkdir(task);
    await fs.writeFile(path.join(task, "AGENTS.md"), "WORKTREE_PROJECT_RULE");
    await fs.writeFile(path.join(state.workspaceDir, "SOUL.md"), "AGENT_WORKSPACE_SOUL");
    const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
    const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
    const origin = "https://control.example.test";
    const auth = {
      mode: "trusted-proxy" as const,
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    };
    const connection = {
      origin,
      clientName: "openclaw-control-ui" as const,
      mode: "webchat" as const,
      scopes: ["operator.admin"],
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    };
    const headers = (user: string) => ({
      "x-forwarded-user": user,
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
    });
    await state.writeConfig({
      agents: { defaults, entries: { main: {} } },
      models,
      plugins: { enabled: false, slots: { memory: "none" } },
      tools: { allow: [], codeMode: { enabled: false }, toolSearch: false },
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: [origin] },
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
      },
    });
    const claim = await acquireGatewayE2ePortBlock();
    const gateway = await startClaimedGateway(claim, () =>
      startGatewayServerCore(claim.port, { controlUiEnabled: false }),
    );
    cleanup.defer(() => gateway.close({ reason: "personal instructions proof complete" }));
    await gateway.startupSettled;
    const clients: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
    for (const person of ["alice", "bob"]) {
      const paired = await pairOperatorDeviceFixture({
        identityPath: state.path(person, "client", "credentials.sqlite"),
        scopes: connection.scopes,
        tokenScopes: connection.scopes,
        clientId: connection.clientName,
        clientMode: connection.mode,
        callerScopes: connection.scopes,
      });
      const connected = await connectGatewayClient({
        ...connection,
        url: `wss://127.0.0.1:${claim.port}`,
        edgeAuthHeaders: headers(`${person}@example.test`),
        signal,
        deviceIdentity: paired.identity,
      });
      clients.push(connected);
      cleanup.defer(() => disconnectGatewayClient(connected));
    }
    const client = clients[0]!;
    const initial = await client.request<UsersPersonalFileGetResult>("users.personalFile.get", {
      agentId: "main",
    });
    const decoy = path.join(task, "users", initial.profileId, "USER.md");
    await fs.mkdir(path.dirname(decoy), { recursive: true });
    await fs.writeFile(decoy, "WORKTREE_PERSONAL_DECOY");
    const created = await client.request<{ key: string; entry: { sessionRoot: string } }>(
      "sessions.create",
      { agentId: "main", cwd: task, permissionMode: "workspace" },
    );
    expect(created.entry.sessionRoot).toBe(task);
    let hash = initial.hash;
    for (const marker of ["INITIAL_PERSONAL_RULE", "UPDATED_PERSONAL_RULE"]) {
      const saved = await client.request<{ hash: string }>("users.personalFile.set", {
        agentId: "main",
        content: marker,
        expectedHash: hash,
      });
      hash = saved.hash;
      const started = await client.request<{ runId: string }>("chat.send", {
        sessionKey: created.key,
        message: "Reply with a short greeting.",
        deliver: false,
        idempotencyKey: marker,
      });
      const waited = await client.request<{ status: string }>(
        "agent.wait",
        { runId: started.runId, timeoutMs: 60_000 },
        { signal, timeoutMs: 65_000 },
      );
      expect(waited.status).toBe("ok");
      // Session naming is a separate request; inspect the agent's project context.
      const request = requests.findLast((body) => body.includes("WORKTREE_PROJECT_RULE"));
      expect(request, "agent request with worktree instructions").toBeDefined();
      expect(request?.includes(marker), "saved preferences reach the agent request").toBe(true);
      expect(request?.includes("WORKTREE_PERSONAL_DECOY")).toBe(false);
      // A project worktree keeps the agent's own identity files.
      expect(request?.includes("AGENT_WORKSPACE_SOUL")).toBe(true);
    }
    expect(requests.filter((body) => body.includes("WORKTREE_PROJECT_RULE"))).toHaveLength(2);
    expect(errors).toEqual([]);
  },
);
