import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
// Prepare the real lazy command graph before the turn's assertion deadline.
import "../agents/agent-command.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { agentExecCommand } from "./agent-exec.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

// The command, config resolver, runner and session stream are real. Only the
// remote model is replaced by an HTTP fixture with a different template default.
it("preserves template defaults and selected thinking through agent exec", async () => {
  const root = tempDirs.make("openclaw-agent-exec-thinking-http-");
  const configPath = path.join(root, "openclaw.json");
  const requests: Record<string, unknown>[] = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as Record<string, unknown>;
        requests.push(payload);
        const kwargs = payload.chat_template_kwargs as Record<string, unknown>;
        const effort = kwargs.reasoning_effort;
        assert(
          effort === undefined || typeof effort === "string",
          "expected a string reasoning effort",
        );
        const text = kwargs.enable_thinking === false ? "off" : (effort ?? "medium");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "chatcmpl_template_fixture",
            choices: [
              { index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    },
    async (baseUrl) => {
      for (const scenario of [
        {
          name: "unselected",
          thinking: undefined,
          configured: undefined,
          result: "medium",
          effort: undefined,
        },
        { name: "selected", thinking: "low", configured: undefined, result: "low", effort: "low" },
        {
          name: "configured",
          thinking: undefined,
          configured: "high",
          result: "xhigh",
          effort: "xhigh",
        },
        { name: "off", thinking: "off", configured: undefined, result: "off", effort: undefined },
      ]) {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            plugins: { enabled: false },
            env: { shellEnv: { enabled: false } },
            agents: {
              defaults: {
                systemAgent: { agentId: "main" },
                model: { primary: "template-fixture/qwen-template" },
                models: {
                  "template-fixture/qwen-template": {
                    agentRuntime: { id: "openclaw" },
                    ...(scenario.configured ? { params: { thinking: scenario.configured } } : {}),
                  },
                },
              },
            },
            models: {
              providers: {
                "template-fixture": {
                  api: "openai-completions",
                  apiKey: "synthetic-unused-key",
                  baseUrl: `${baseUrl}/v1`,
                  request: { allowPrivateNetwork: true },
                  models: [
                    {
                      id: "qwen-template",
                      name: "Template fixture",
                      reasoning: true,
                      input: ["text"],
                      contextWindow: 32000,
                      maxTokens: 1024,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      compat: {
                        thinkingFormat: "qwen-chat-template",
                        supportedReasoningEfforts: ["low", "medium", "xhigh"],
                        reasoningEffortMap: { high: "xhigh" },
                      },
                    },
                  ],
                },
              },
            },
          }),
        );
        const previousCount = requests.length;
        const result = await agentExecCommand(
          "Reply briefly without tools.",
          {
            config: configPath,
            cwd: root,
            stateDir: root,
            thinking: scenario.thinking,
            codeMode: "direct",
            json: true,
          },
          {
            log() {},
            error() {},
            exit(code) {
              throw new Error(`Unexpected exit ${code}`);
            },
          },
        );
        expect(result.exitCode, scenario.name).toBe(0);
        expect(requests.length, scenario.name).toBe(previousCount + 1);
        const payload = requests[previousCount];
        assert(payload, `${scenario.name}: expected a provider request`);
        expect(payload).not.toHaveProperty("openclawThinkingExplicit");
        if (scenario.effort) {
          expect(payload.chat_template_kwargs).toMatchObject({ reasoning_effort: scenario.effort });
        } else {
          expect(payload).not.toHaveProperty("chat_template_kwargs.reasoning_effort");
        }
        expect(result.envelope).toMatchObject({ status: "ok" });
        expect(result.envelope.final).toBe(scenario.result);
      }
    },
  );
});
