import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { json } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import type { Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { resolvePreparedRunAdmission } from "../agents/admitted-run-context.js";
import type {
  EmbeddedAgentRunResult,
  runEmbeddedAgent as runEmbeddedAgentType,
} from "../agents/embedded-agent.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

export type EmbeddedRunParams = Parameters<typeof runEmbeddedAgentType>[0];
export type SpawnReceipt = { runId: string; childSessionKey: string };
export type KillResponse = { status: number; body: unknown };

export const completedEmbeddedRun: EmbeddedAgentRunResult = {
  payloads: [],
  meta: { durationMs: 1 },
};

const proxyUser = "subagent-stop-administrator@example.test";
const operatorScopes = ["operator.admin", "operator.read", "operator.write"] as const;
export const subagentStopProxyHeaders = {
  "x-forwarded-for": "203.0.113.81",
  "x-forwarded-proto": "https",
  "x-forwarded-user": proxyUser,
};

export function buildSubagentStopConfig(
  workspace: string,
  tls: { certPath: string; keyPath: string },
): OpenClawConfig {
  const { api, baseUrl, provider, ...model } = makeProviderModelFixture<"openai-responses">({
    id: "stop-proof",
    name: "Stop proof",
    provider: "synthetic",
    api: "openai-responses",
    baseUrl: "https://example.invalid/v1",
    contextWindow: 4096,
    maxTokens: 1024,
  });
  const trustedProxy = {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowUsers: [proxyUser],
    allowLoopback: true,
    deviceAutoApprove: { enabled: true, scopes: [...operatorScopes] },
  };
  return {
    cron: { enabled: false },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "synthetic/stop-proof" },
        subagents: { allowAgents: ["*"] },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [provider]: {
          api,
          baseUrl,
          apiKey: "synthetic-test-key",
          models: [model],
        },
      },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
    tools: { profile: "coding", toolSearch: false },
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy,
        identityScopes: { [proxyUser]: [...operatorScopes] },
      },
      trustedProxies: ["127.0.0.1"],
      tls: { enabled: true, autoGenerate: false, ...tls },
      controlUi: { allowedOrigins: ["https://control.example.com"] },
      roles: {
        default: "administrator",
        definitions: {
          administrator: {
            agents: "*",
            sessions: { others: "write" },
            scopes: [...operatorScopes],
          },
        },
      },
    },
  };
}

async function spawnChild(params: EmbeddedRunParams) {
  const admitted = await resolvePreparedRunAdmission({
    runId: params.runId,
    runtimeKind: "embedded",
    admittedRunContext: params.admittedRunContext,
    preparedRunAdmission: params.preparedRunAdmission,
  });
  const sessionKey = expectDefined(params.sessionKey, "admitted parent session key");
  const agentId = expectDefined(params.agentId, "admitted parent agent id");
  const config = expectDefined(params.config, "admitted parent config");
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId,
    sessionKey,
  });
  const tool = createSessionsSpawnTool({
    config,
    agentSessionKey: sessionKey,
    expectedParentSessionId: params.sessionId,
    requesterRunId: params.runId,
    requesterTurnRunId: params.runId,
    requesterModel: {
      provider: expectDefined(params.provider, "admitted parent provider"),
      model: expectDefined(params.model, "admitted parent model"),
    },
    senderIsOwner: true,
  });
  const result = await withGatewayToolCallerIdentity(caller, () =>
    tool.execute!("natural-subagent-stop-proof", {
      task: "Hold until the operator stops this child.",
      context: "isolated",
      expectsCompletionMessage: false,
    }),
  );
  return result.details as SpawnReceipt;
}

export function postSubagentKill(port: number, sessionKey: string) {
  return new Promise<KillResponse>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/sessions/${encodeURIComponent(sessionKey)}/kill`,
        method: "POST",
        rejectUnauthorized: false,
        headers: { ...subagentStopProxyHeaders, "x-openclaw-scopes": "operator.admin" },
      },
      (response) => {
        void json(response).then(
          (body: unknown) => resolve({ status: response.statusCode ?? 0, body }),
          reject,
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

/** Creates a natural Gateway parent whose real spawn reaches the supplied child adapter. */
export async function createNaturalSubagentStopHarness(params: {
  label: string;
  runEmbeddedAgent: Mock<typeof runEmbeddedAgentType>;
  runChild: (params: EmbeddedRunParams) => Promise<EmbeddedAgentRunResult>;
}) {
  const state = await createOpenClawTestState({ label: params.label });
  setUserProfileRole(ensureProfileForEmail(proxyUser).id, "administrator");
  const cfg = buildSubagentStopConfig(state.workspaceDir, {
    certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
    keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
  });
  const spawned = createDeferred<SpawnReceipt>();
  params.runEmbeddedAgent.mockImplementation(async (run) => {
    await run.onExecutionStarted?.();
    if (run.sessionKey?.includes(":subagent:")) {
      return await params.runChild(run);
    }
    const receipt = await spawnChild(run);
    spawned.resolve(receipt);
    return completedEmbeddedRun;
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  return {
    state,
    cfg,
    async start() {
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        auth: cfg.gateway?.auth,
        edgeAuthHeaders: subagentStopProxyHeaders,
        secure: true,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: "https://control.example.com",
        scopes: [...operatorScopes],
      });
      await gateway.server.startupSettled;
    },
    async spawn() {
      const activeGateway = expectDefined(gateway, "started natural subagent Gateway");
      const parentRunId = `${params.label}-parent`;
      const parentSessionKey = `agent:main:${params.label}-parent`;
      const accepted = await activeGateway.client.request<{ runId: string; status: string }>(
        "chat.send",
        {
          sessionKey: parentSessionKey,
          message: "Spawn the held child now.",
          idempotencyKey: parentRunId,
          deliver: false,
        },
      );
      if (accepted.runId !== parentRunId || accepted.status !== "started") {
        throw new Error(`Natural parent was not admitted: ${JSON.stringify(accepted)}`);
      }
      return await spawned.promise;
    },
    stop(sessionKey: string) {
      return postSubagentKill(
        expectDefined(gateway, "started natural subagent Gateway").port,
        sessionKey,
      );
    },
    disconnect: () => gateway && disconnectGatewayClient(gateway.client),
    close: () => gateway?.server.close({ reason: `${params.label} complete` }),
  };
}
