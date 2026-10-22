import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
// Prepare the real lazy command graph before the turn's assertion deadline.
import "../agents/agent-command.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { agentExecCommand } from "./agent-exec.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("preserves template defaults and selected thinking through agent exec", async () => {
  const root = tempDirs.make("openclaw-agent-exec-thinking-http-");
  const configPath = path.join(root, "openclaw.json");
  const model = "template-fixture/qwen-template";
  const requests: Record<string, unknown>[] = [];
  await withServer(
    (request, response) => {
      void (async () => {
        const payload = JSON.parse(await text(request)) as Record<string, unknown>;
        requests.push(payload);
        const kwargs = payload.chat_template_kwargs as Record<string, unknown>;
        const effort = kwargs.reasoning_effort;
        assert(
          effort === undefined || typeof effort === "string",
          "expected a string reasoning effort",
        );
        const content = kwargs.enable_thinking === false ? "off" : (effort ?? "medium");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "chatcmpl_template_fixture",
            choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    },
    async (baseUrl) => {
      const compat = {
        thinkingFormat: "qwen-chat-template",
        supportedReasoningEfforts: ["low", "medium", "xhigh"],
        reasoningEffortMap: { high: "xhigh" },
      };
      const provider = {
        api: "openai-completions",
        apiKey: "synthetic-unused-key",
        baseUrl: `${baseUrl}/v1`,
        request: { allowPrivateNetwork: true },
        models: [{ id: "qwen-template", name: "Template fixture", reasoning: true, compat }],
      };
      for (const [name, thinking, configured, resultText, effort] of [
        ["unselected", undefined, undefined, "medium", undefined],
        ["selected", "low", undefined, "low", "low"],
        ["configured", undefined, "high", "xhigh", "xhigh"],
        ["off", "off", undefined, "off", undefined],
      ] as const) {
        const defaults = {
          systemAgent: { agentId: "main" },
          model: { primary: model },
          models: {
            [model]: {
              agentRuntime: { id: "openclaw" },
              params: configured ? { thinking: configured } : undefined,
            },
          },
        };
        await fs.writeFile(
          configPath,
          JSON.stringify({
            plugins: { enabled: false },
            env: { shellEnv: { enabled: false } },
            agents: { defaults },
            models: { providers: { "template-fixture": provider } },
          }),
        );
        const previousCount = requests.length;
        const result = await agentExecCommand(
          "Reply briefly without tools.",
          {
            config: configPath,
            cwd: root,
            stateDir: root,
            thinking,
            codeMode: "direct",
            json: true,
          },
          createThrowingTestRuntime(),
        );
        expect(result, name).toMatchObject({
          exitCode: 0,
          envelope: { status: "ok", final: resultText },
        });
        expect(requests.length, name).toBe(previousCount + 1);
        const payload = requests[previousCount];
        assert(payload, `${name}: expected a provider request`);
        expect(payload).not.toHaveProperty("openclawThinkingExplicit");
        if (effort) {
          expect(payload.chat_template_kwargs).toMatchObject({ reasoning_effort: effort });
        } else {
          expect(payload).not.toHaveProperty("chat_template_kwargs.reasoning_effort");
        }
      }
    },
  );
});
