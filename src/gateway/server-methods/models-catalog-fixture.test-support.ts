import type { Server } from "node:http";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "../client.js";
import { startGatewayWithClient } from "../test-helpers.e2e.js";
import { createModelsTestState, listenModelsEndpoint } from "./models-integration.test-support.js";

export function createCatalogState(label: string, env: Record<string, string | undefined> = {}) {
  return createModelsTestState(label, {
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, ...env },
  });
}

export const listenCatalogServer = listenModelsEndpoint;

export async function writeCatalogPlugin(
  state: OpenClawTestState,
  provider: string | string[],
  source: string,
  manifest: Record<string, unknown> = {},
) {
  const providers = typeof provider === "string" ? [provider] : provider;
  await state.writeJson("catalog-plugin/openclaw.plugin.json", {
    id: providers[0],
    providers,
    configSchema: { type: "object", additionalProperties: false },
    ...manifest,
  });
  return state.writeText("catalog-plugin/index.cjs", source);
}

export function startCatalogGateway(
  state: OpenClawTestState,
  cfg: unknown,
  token: string,
  options: Pick<Parameters<typeof startGatewayWithClient>[0], "hotReloadRecovery"> = {},
) {
  return startGatewayWithClient({
    cfg,
    token,
    configPath: state.configPath,
    scopes: ["operator.admin"],
    ...options,
  });
}

export async function closeCatalogServer(endpoint: Server, rejectErrors = false) {
  endpoint.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    endpoint.close((error) => (error && rejectErrors ? reject(error) : resolve()));
  });
}

export function expectAssistantReply(messages: unknown[], text: string) {
  expect(messages).toContainEqual(
    expect.objectContaining({
      role: "assistant",
      content: expect.arrayContaining([expect.objectContaining({ type: "text", text })]),
    }),
  );
}

export function catalogModelDefaults() {
  return {
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

export function createCatalogModel(id: string, name = id) {
  return { id, name, ...catalogModelDefaults() };
}

export function catalogReply(id: string, model: string, text: string) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  })}\n\ndata: [DONE]\n\n`;
}

export function catalogAgents(
  state: OpenClawTestState,
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"],
) {
  return { defaults, entries: { main: { workspace: state.workspaceDir } } };
}

export function catalogSessionRpc(client: GatewayClient) {
  return {
    create: (model: string, key: string, extra: { label?: string; cwd?: string } = {}) =>
      client.request<{ ok: boolean; key: string; entry: { spawnedCwd: string } }>(
        "sessions.create",
        { agentId: "main", model, key, ...extra },
      ),
    send: (sessionKey: string, message: string, idempotencyKey: string) =>
      client.request<{ runId: string; status: string }>("chat.send", {
        sessionKey,
        message,
        idempotencyKey,
      }),
    wait: (runId: string) =>
      client.request<{ status: string; error?: string }>(
        "agent.wait",
        { runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      ),
    history: (sessionKey: string) =>
      client.request<{ messages: unknown[] }>("chat.history", { sessionKey }),
  };
}

export function createCatalogAuthProfiles(keys: Record<string, string>) {
  return {
    version: 1,
    profiles: Object.fromEntries(
      Object.entries(keys).map(([provider, key]) => [
        `${provider}:default`,
        { type: "api_key" as const, provider, key },
      ]),
    ),
  };
}

export function catalogModelIds(
  result: { models: Array<{ provider: string; id: string }> },
  provider: string,
) {
  return result.models.filter((row) => row.provider === provider).map((row) => row.id);
}
