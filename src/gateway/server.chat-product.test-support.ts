import { createServer, type ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readProviderBody } from "./gateway-provider-fixture.test-support.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

export const createProductState = (label: string) =>
  createOpenClawTestState({
    label,
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });

export function productModelConfig(
  workspace: string,
  provider: ReturnType<typeof buildMockOpenAiResponsesProvider>,
) {
  return {
    defaults: {
      workspace,
      skipBootstrap: true,
      model: { primary: provider.modelRef },
      models: {
        [provider.modelRef]: {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
      },
    },
  } satisfies {
    defaults: NonNullable<OpenClawConfig["agents"]>["defaults"];
    models: OpenClawConfig["models"];
  };
}

export function productProvider(
  errors: unknown[],
  handle: (body: string, response: ServerResponse, url?: string) => void | Promise<void>,
) {
  return createServer((request, response) => {
    void readProviderBody(request)
      .then((body) => handle(body, response, request.url))
      .catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end("fixture provider failed");
      });
  });
}
