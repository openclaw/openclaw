import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../src/config/config.js";
import type { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { openNodeSqliteDatabase } from "../src/infra/node-sqlite.js";
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
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      await handle(request, response, asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    })().catch((error: unknown) => {
      failed.reject(error);
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

export function restartToolNames(body: Record<string, unknown>) {
  return Array.isArray(body.tools)
    ? body.tools.flatMap((tool) =>
        isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
      )
    : [];
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
      response: {
        id: `resp_${key}_${ordinal}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

export function writeRestartTitle(response: ServerResponse, text: string) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "resp_title",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_title",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  );
}

export function readRestartSession(agentDir: string, sessionKey: string) {
  const row = readRestartRow(
    path.join(agentDir, "openclaw-agent.sqlite"),
    "SELECT entry_json FROM session_nodes WHERE session_key = ?",
    sessionKey,
  );
  return typeof row?.entry_json === "string" ? asRecord(JSON.parse(row.entry_json)) : undefined;
}

export function readRestartRow(databasePath: string, sql: string, key: string) {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(key);
  } finally {
    database.close();
  }
}

export function restartModelConfig(
  model: ReturnType<typeof buildMockOpenAiResponsesProvider>,
  workspace: string,
  subagents?: { runTimeoutSeconds: number },
): Pick<OpenClawConfig, "models" | "agents"> {
  return {
    models: {
      mode: "replace",
      providers: {
        [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
      },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: model.modelRef },
        modelPolicy: { allow: [model.modelRef] },
        models: {
          [model.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        heartbeat: { every: "0m" },
        skipBootstrap: true,
        skills: [],
        timeoutSeconds: 120,
        ...(subagents ? { subagents } : {}),
      },
      entries: { main: {} },
    },
  };
}
