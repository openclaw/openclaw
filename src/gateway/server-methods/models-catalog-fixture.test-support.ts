import { once } from "node:events";
import type { Server } from "node:http";
import { expect } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { startGatewayWithClient } from "../test-helpers.e2e.js";

export function createCatalogState(label: string, env: Record<string, string | undefined> = {}) {
  return createOpenClawTestState({
    label,
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      ...env,
    },
  });
}

export async function listenCatalogServer(endpoint: Server) {
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  const address = endpoint.address();
  if (!address || typeof address === "string") {
    throw new Error("Catalog fixture did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

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
  expect(messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([expect.objectContaining({ type: "text", text })]),
      }),
    ]),
  );
}

export function createCatalogModel(id: string, name = id) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
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
