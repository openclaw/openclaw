import { expect } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";

export function createChatGatewayInstance(options: {
  name: string;
  provider: string;
  identity: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  models: Record<string, unknown>[];
  api?: string;
  agents?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  config?: Record<string, unknown>;
  entrypoint?: string[];
}) {
  return createOpenClawTestInstance({
    name: options.name,
    entrypoint: options.entrypoint,
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
    config: {
      gateway: { controlUi: { enabled: true } },
      cron: { enabled: false },
      agents: {
        defaults: {
          model: `${options.provider}/${options.model}`,
          modelPolicy: { allow: [`${options.provider}/*`] },
          ...options.defaults,
        },
        entries: { main: { identity: { name: options.identity } } },
        ...options.agents,
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          [options.provider]: {
            api: options.api ?? "openai-responses",
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            models: options.models,
          },
        },
      },
      plugins: { allow: [] },
      ...options.config,
    },
  });
}

export async function runGatewayCli(instance: OpenClawTestInstance, args: string[]) {
  const result = await instance.cli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

export function callGateway(
  instance: OpenClawTestInstance,
  method: string,
  params: Record<string, unknown>,
) {
  return runGatewayCli(instance, [
    "gateway",
    "call",
    method,
    "--json",
    "--params",
    JSON.stringify(params),
  ]);
}

export async function gatewayChatUrl(instance: OpenClawTestInstance, slug: string) {
  const { browserUrl }: { browserUrl: string } = JSON.parse(
    await runGatewayCli(instance, ["dashboard", "--json"]),
  );
  const url = new URL(browserUrl);
  url.pathname = `/chat/main/${slug}`;
  url.search = "";
  return url;
}
