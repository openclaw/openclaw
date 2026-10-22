import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../src/config/config.js";
import type { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
import { readRequestText, respondJson } from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "./helpers/openai-responses-sse.js";

export const restartEnv = {
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_API_BASE: undefined,
  OPENCLAW_SKIP_PROVIDERS: undefined,
  OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
};

export function restartProviderServer(
  failed: { reject(error: unknown): void },
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) => Promise<void>,
) {
  return createServer((request, response) => {
    void (async () => {
      await handle(request, response, asRecord(JSON.parse(await readRequestText(request))));
    })().catch((error: unknown) => {
      failed.reject(error);
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

export function writeRestartToolCall(
  response: ServerResponse,
  key: string,
  name: string,
  args: unknown,
  ordinal: number,
) {
  const item = {
    type: "function_call",
    id: `fc_${key}_${ordinal}`,
    call_id: `call_${key}_${ordinal}`,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: completedResponse(`resp_${key}_${ordinal}`, [item]),
    },
  ]);
}

export function writeRestartTitle(response: ServerResponse, text: string) {
  respondJson(response, {
    object: "response",
    ...completedResponse("resp_title", [
      {
        type: "message",
        id: "msg_title",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ]),
  });
}

export function readRestartSession(agentDir: string, sessionKey: string) {
  const database = openNodeSqliteDatabase(path.join(agentDir, "openclaw-agent.sqlite"), {
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
  workspace: string,
): Pick<OpenClawConfig, "models" | "agents"> {
  const { modelRef, providerId, config } = model;
  return {
    models: {
      mode: "replace",
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
      },
      entries: { main: {} },
    },
  };
}
