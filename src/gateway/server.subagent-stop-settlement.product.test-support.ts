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

export function findSubagentRecords(
  value: unknown,
  matches: (record: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return findSubagentRecords(JSON.parse(value) as unknown, matches);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => findSubagentRecords(item, matches));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    ...(matches(record) ? [record] : []),
    ...Object.values(record).flatMap((item) => findSubagentRecords(item, matches)),
  ];
}

export function findSubagentSpawnReceipt(value: unknown): SpawnReceipt | undefined {
  const record = findSubagentRecords(
    value,
    (entry) =>
      entry.status === "accepted" &&
      typeof entry.childSessionKey === "string" &&
      typeof entry.runId === "string",
  )[0];
  if (record && typeof record.childSessionKey === "string" && typeof record.runId === "string") {
    return { childSessionKey: record.childSessionKey, runId: record.runId };
  }
  return undefined;
}

export const completedEmbeddedRun: EmbeddedAgentRunResult = {
  payloads: [],
  meta: { durationMs: 1 },
};

const proxyUser = "subagent-stop-administrator@example.test";
const operatorScopes = ["operator.admin", "operator.read", "operator.write"] as const;
const subagentStopProxyHeaders = {
  "x-forwarded-for": "203.0.113.81",
  "x-forwarded-proto": "https",
  "x-forwarded-user": proxyUser,
};

export function subagentToolCallEvents(
  name: string,
  args: Record<string, unknown>,
  sequence: number,
) {
  const item = {
    type: "function_call",
    id: `fc_subagent_${sequence}`,
    call_id: `call_subagent_${sequence}`,
    name,
    arguments: JSON.stringify(args),
  };
  const response = { id: `resp_subagent_${sequence}`, object: "response" };
  const argumentsEvent = (type: string, data: Record<string, unknown>) => ({
    type: `response.function_call_arguments.${type}`,
    item_id: item.id,
    output_index: 0,
    ...data,
  });
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    argumentsEvent("delta", { delta: item.arguments }),
    argumentsEvent("done", { arguments: item.arguments }),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    },
  ];
}

export function createSubagentModelConfig(
  workspace: string,
  options: { modelId?: string; name?: string; baseUrl?: string; runtime?: boolean } = {},
): OpenClawConfig {
  const modelId = options.modelId ?? "stop-proof";
  const runtime = options.runtime ? { agentRuntime: { id: "openclaw" as const } } : {};
  const { api, baseUrl, provider, ...model } = makeProviderModelFixture<"openai-responses">({
    id: modelId,
    name: options.name ?? "Stop proof",
    provider: "synthetic",
    api: "openai-responses",
    baseUrl: options.baseUrl ?? "https://example.invalid/v1",
    // Lifecycle scenarios carry the full coding tool surface and system prompt.
    contextWindow: 128_000,
    maxTokens: 1024,
  });
  return {
    cron: { enabled: false },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: `synthetic/${modelId}` },
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
          ...runtime,
          ...(options.baseUrl ? { request: { allowPrivateNetwork: true } } : {}),
          models: [
            {
              ...model,
              ...runtime,
              ...(options.runtime
                ? { api, params: { transport: "sse", openaiWsWarmup: false } }
                : {}),
            },
          ],
        },
      },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
    tools: { profile: "coding", toolSearch: false },
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

export async function createSubagentStopFixture(label: string, modelUrl?: string) {
  const state = await createOpenClawTestState({ label });
  setUserProfileRole(ensureProfileForEmail(proxyUser).id, "administrator");
  const cfg: OpenClawConfig = {
    ...createSubagentModelConfig(state.workspaceDir, { baseUrl: modelUrl || undefined }),
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: [proxyUser],
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes: [...operatorScopes] },
        },
        identityScopes: { [proxyUser]: [...operatorScopes] },
      },
      trustedProxies: ["127.0.0.1"],
      tls: {
        enabled: true,
        autoGenerate: false,
        certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
        keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
      },
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
  return {
    state,
    cfg,
    start: (onEvent?: Parameters<typeof startGatewayWithClient>[0]["onEvent"]) =>
      startGatewayWithClient({
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
        onEvent,
      }),
  };
}

/** Creates a natural Gateway parent whose real spawn reaches the supplied child adapter. */
export async function createNaturalSubagentStopHarness(params: {
  label: string;
  runEmbeddedAgent: Mock<typeof runEmbeddedAgentType>;
  runChild: (params: EmbeddedRunParams) => Promise<EmbeddedAgentRunResult>;
}) {
  const { state, cfg, start } = await createSubagentStopFixture(params.label);
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
      gateway = await start();
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
