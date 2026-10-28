import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../src/config/config.js";
import type { GatewayClientOptions } from "../src/gateway/client.js";
import type { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { readRequestText, respondJson } from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";
import type { OpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

export const restartEnv = {
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_API_BASE: undefined,
  OPENCLAW_SKIP_PROVIDERS: undefined,
  OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
};

export function connectRestartClient(
  instance: OpenClawTestInstance,
  options: Omit<GatewayClientOptions, "url" | "token" | "onConnectError"> = {},
  signal?: AbortSignal,
  timeoutMs = 30_000,
) {
  return acquireGatewayTestClient(
    {
      url: instance.url,
      token: instance.gatewayToken,
      clientName: "gateway-client",
      mode: "backend",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity:
        options.deviceIdentity === undefined
          ? loadOrCreateDeviceIdentity({
              path: instance.state.path("device", "client", "credentials.sqlite"),
            })
          : options.deviceIdentity,
      ...options,
    },
    {
      timeoutMs,
      timeoutMessage: "restart client did not connect",
      closeMessage: "restart client closed",
      signal,
    },
  );
}

export async function writeRestartPlugin(
  pluginDir: string,
  manifest: object,
  source: string,
  entry = "index.mjs",
) {
  await mkdir(pluginDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest)),
    writeFile(path.join(pluginDir, entry), source),
  ]);
}

export function restartProviderServer(
  failed: { reject(error: unknown): void },
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) => Promise<void>,
  options: { ignoreAborted?: boolean } = {},
) {
  return createServer((request, response) => {
    void (async () => {
      await handle(request, response, asRecord(JSON.parse(await readRequestText(request))));
    })().catch((error: unknown) => {
      if (!options.ignoreAborted || !request.aborted) {
        failed.reject(error);
      }
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

export function restartToolNames(body: Record<string, unknown>) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
}

function completedResponse(id: string, output: object[]) {
  return {
    id,
    status: "completed",
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

type ToolCall = {
  type: string;
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
};

export function writeRestartToolCalls(
  response: ServerResponse,
  responseId: string,
  items: ToolCall[],
  options: {
    argumentEvent?: "delta" | "done";
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  } = {},
) {
  const done = options.argumentEvent === "done";
  writeOpenAiResponsesSse(response, [
    ...items.flatMap((item, output_index) => [
      {
        type: "response.output_item.added",
        output_index,
        item: { ...item, ...(item.status ? { status: "in_progress" } : {}), arguments: "" },
      },
      {
        type: done
          ? "response.function_call_arguments.done"
          : "response.function_call_arguments.delta",
        output_index,
        item_id: item.id,
        ...(done ? { arguments: item.arguments } : { delta: item.arguments }),
      },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: {
        ...completedResponse(responseId, items),
        ...(options.usage ? { usage: options.usage } : {}),
      },
    },
  ]);
}

export function writeRestartToolCall(
  response: ServerResponse,
  key: string,
  name: string,
  args: unknown,
  ordinal: number,
) {
  writeRestartToolCalls(response, `resp_${key}_${ordinal}`, [
    {
      type: "function_call",
      id: `fc_${key}_${ordinal}`,
      call_id: `call_${key}_${ordinal}`,
      name,
      arguments: JSON.stringify(args),
    },
  ]);
}

export function writeRestartJsonText(
  response: ServerResponse,
  text: string,
  key: string,
  options: { object?: boolean; completed?: boolean } = {},
) {
  respondJson(response, {
    ...(options.object ? { object: "response" } : {}),
    ...completedResponse(`resp_${key}`, [
      {
        type: "message",
        id: `msg_${key}`,
        role: "assistant",
        ...(options.completed ? { status: "completed" } : {}),
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ]),
  });
}

export function writeRestartTitle(response: ServerResponse, text: string) {
  writeRestartJsonText(response, text, "title", { object: true, completed: true });
}

export function readRestartSession(
  agentDir: string,
  sessionKey: string,
  storePath = path.join(agentDir, "openclaw-agent.sqlite"),
) {
  const database = openNodeSqliteDatabase(storePath, {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey);
    return typeof row?.entry_json === "string" ? asRecord(JSON.parse(row.entry_json)) : undefined;
  } finally {
    database.close();
  }
}

export function restartModelConfig(
  model: ReturnType<typeof buildMockOpenAiResponsesProvider>,
  workspace: string | undefined,
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
  models: Omit<NonNullable<OpenClawConfig["models"]>, "providers"> = {},
): Pick<OpenClawConfig, "models" | "agents"> {
  const { modelRef, providerId, config } = model;
  return {
    models: {
      mode: "replace",
      ...models,
      providers: {
        [providerId]: { ...config, request: { allowPrivateNetwork: true } },
      },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: modelRef },
        modelPolicy: { allow: [modelRef] },
        models: {
          [modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        skipBootstrap: true,
        skills: [],
        timeoutSeconds: 120,
        ...defaults,
      },
      entries: { main: {} },
    },
  };
}

export async function readRestartTrace(tracePath: string): Promise<string[]> {
  try {
    return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
