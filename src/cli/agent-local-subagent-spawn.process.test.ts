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
const parentTask = "PARENT-SPAWN-PROBE";
const childTask = "CHILD-SPAWN-PROBE";
const childResult = "CHILD-RESULT-323";

function spawnCall(response: ServerResponse) {
  const id = randomUUID();
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    // sessions_spawn is deferred on this profile; the model reaches it through dispatch.
    name: "dispatch_action",
    arguments: JSON.stringify({
      id: "sessions_spawn",
      args: { task: `${childTask}: reply with 323.`, runtime: "subagent" },
    }),
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

it(
  "agent --local spawns a subagent and continues with its result",
  { timeout: 120_000 },
  async () => {
    const root = tempDirs.make("openclaw-local-subagent-spawn-");
    const fixture = createCliProcessFixture(root, {
      TMPDIR: root,
      NO_COLOR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    });
    let parentRequests = 0;
    let childRequests = 0;
    let spawnResult = "";
    let continuationSawChildResult = false;
    const server = await startOpenAiResponsesModelServer({
      modelId: "gpt-5.2",
      bindError: "spawn probe provider did not bind",
      onRequest: async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const input = JSON.stringify(body.input ?? "");
        const reply = (text: string) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: `msg_${randomUUID()}`,
            responseId: `resp_${randomUUID()}`,
          });
        if (input.includes(childTask) && !input.includes(parentTask)) {
          childRequests++;
          reply(childResult);
          return;
        }
        if (!input.includes(parentTask)) {
          reply("metadata complete");
          return;
        }
        parentRequests++;
        if (parentRequests === 1) {
          spawnCall(response);
          return;
        }
        if (!spawnResult && Array.isArray(body.input)) {
          spawnResult = JSON.stringify(
            body.input.filter((entry) => asRecord(entry).type === "function_call_output"),
          );
        }
        // The completion arrives as a later parent turn that carries the child's reply.
        continuationSawChildResult ||= input.includes(childResult);
        reply("parent complete");
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
      config.plugins = { allow: ["openai"] };
      config.agents = {
        ...config.agents,
        defaults: { ...config.agents?.defaults, workspace: path.join(root, "workspace") },
        entries: { main: {} },
      };
      await fixture.writeConfig(config);
      const result = await runCliProcessChild({
        env: fixture.env,
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
      expect(spawnResult, result.stderr).toContain("accepted");
      expect(childRequests, result.stderr).toBe(1);
      expect(continuationSawChildResult, result.stderr).toBe(true);
    } finally {
      await server.close();
    }
  },
);
