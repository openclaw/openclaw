import { createServer } from "node:http";
import {
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayBackgroundTestEnv } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

/** Real HTTP model fixture; each scenario controls its own request gates. */
export async function createStartupRecoveryFixture(
  label: string,
  onRequest: (body: string) => Promise<void>,
  options: { maxConcurrent: number; responseText: string; controlUi?: boolean },
) {
  const token = `${label}-token`;
  const state = await createOpenClawTestState({
    label,
    env: createGatewayBackgroundTestEnv(token),
  });
  let responseCount = 0;
  const provider = createServer((request, response) => {
    void (async () => {
      const body = await readRequestText(request);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      if (!body.includes("Generate a concise session title")) {
        await onRequest(body);
      }
      responseCount += 1;
      writeOpenAiResponsesText(response, {
        text: options.responseText,
        messageId: `${label}-${responseCount}`,
        responseId: `${label}-response-${responseCount}`,
      });
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let baseUrl: string;
  try {
    baseUrl = await listenLoopback(provider);
  } catch (error) {
    await state.cleanup();
    throw error;
  }
  const model = buildMockOpenAiResponsesProvider(`${baseUrl}/v1`, `gpt-${label}`);
  const cfg = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        maxConcurrent: options.maxConcurrent,
        model: { primary: model.modelRef },
        models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
      },
      entries: { main: {} },
    },
    messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
    models: { mode: "replace", providers: { [model.providerId]: model.config } },
    gateway: {
      auth: { mode: "token", token },
      ...(options.controlUi ? { controlUi: { allowedOrigins: ["http://localhost:18789"] } } : {}),
    },
    plugins: { slots: { memory: "none" } },
  } satisfies OpenClawConfig;
  return { state, provider, cfg, token, responseCount: () => responseCount };
}
