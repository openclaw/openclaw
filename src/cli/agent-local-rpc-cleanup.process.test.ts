import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parentTask = "PARENT-CLEANUP-PROBE";

function tool(response: ServerResponse, code: string) {
  const id = randomUUID();
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name: "exec",
    arguments: JSON.stringify({ code, awaitResults: true }),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    },
  ]);
}

function findToolResult(value: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return findToolResult(JSON.parse(value), field);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = asRecord(value);
  if (field in record) {
    return record;
  }
  for (const child of Object.values(value)) {
    const found = findToolResult(child, field);
    if (found) {
      return found;
    }
  }
  return undefined;
}

it(
  "agent --local settles projection cleanup after a session RPC",
  { timeout: 120_000 },
  async () => {
    const root = tempDirs.make("openclaw-local-rpc-cleanup-");
    const fixture = createCliProcessFixture(root, {
      TMPDIR: root,
      NO_COLOR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    });
    let parentRequests = 0;
    let listed = false;
    const server = await startOpenAiResponsesModelServer({
      modelId: "gpt-5.2",
      bindError: "cleanup probe provider did not bind",
      onRequest: async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (body.stream === false) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: `resp_${randomUUID()}`,
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: `msg_${randomUUID()}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Cleanup probe", annotations: [] }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        const userInput = Array.isArray(body.input)
          ? body.input.filter((entry) => asRecord(entry).role === "user")
          : body.input;
        const visible = JSON.stringify(userInput ?? "");
        const reply = (text: string) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: `msg_${randomUUID()}`,
            responseId: `resp_${randomUUID()}`,
          });
        if (!visible.includes(parentTask)) {
          reply("metadata complete");
          return;
        }
        parentRequests++;
        if (parentRequests === 1) {
          tool(response, "text(await sessions_list({limit:1}));");
        } else {
          listed = Array.isArray(findToolResult(body.input, "sessions")?.sessions);
          reply("parent complete");
        }
      },
    });
    try {
      const config = createOpenAiResponsesModelConfig({
        baseUrl: server.baseUrl,
        providerId: "openai",
        modelId: "gpt-5.2",
        reasoning: false,
        toolProfile: "full",
      });
      config.plugins = { allow: ["openai", "memory-core"] };
      config.agents = {
        ...config.agents,
        defaults: { ...config.agents?.defaults, workspace: path.join(root, "workspace") },
        entries: { main: {} },
      };
      config.tools = { ...config.tools, codeMode: { enabled: true } };
      await fixture.writeConfig(config);
      const result = await runCliProcessChild({
        env: fixture.env,
        // Match the source SDK's native ESM loader; the full tsx CJS hook
        // rewrites import-only dependencies when bundled plugins load.
        nodeArgs: [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          fileURLToPath(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          "agent",
          "--local",
          "--agent",
          "main",
          "--session-id",
          randomUUID(),
          "--message",
          parentTask,
          "--thinking",
          "off",
          "--timeout",
          "60",
          "--json",
        ],
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(result.stdout)).toMatchObject({ payloads: [{ text: "parent complete" }] });
      expect(listed, result.stderr).toBe(true);
      expect(result.stderr).not.toContain("CLI cleanup failed");
    } finally {
      await server.close();
    }
  },
);
